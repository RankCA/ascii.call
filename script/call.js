/*
 * call.js – ASCII Video Call via Supabase Realtime
 *
 * Depends on:
 *   window.supabase  (from @supabase/supabase-js UMD build)
 *   window.camera    (camera.js)
 *   window.ascii     (ascii.js)
 */

(function () {
	'use strict';

	/* ── Constants ──────────────────────────────────────────────────────── */

	var CAMERA_WIDTH  = 80;
	var CAMERA_HEIGHT = 60;
	var CAMERA_FPS    = 15;

	/**
	 * Broadcast every Nth rendered frame so we don't flood the channel.
	 * 15 fps / 5 = 3 broadcast frames per second – light on bandwidth.
	 */
	var BROADCAST_EVERY_N_FRAMES = 5;

	/**
	 * Remove a remote feed if we haven't received a frame from that peer
	 * within this many milliseconds (handles silent disconnects).
	 */
	var PEER_TIMEOUT_MS = 12000;

	var SESSION_KEY = 'asciiCallCreds';

	/* ── State ──────────────────────────────────────────────────────────── */

	var supabaseClient = null;
	var channel        = null;
	var cameraRunning  = false;
	var feedPaused     = false;
	var frameCount     = 0;

	/**
	 * Unique ID for this browser tab / session.
	 * crypto.randomUUID() is available in all modern browsers (and HTTPS).
	 */
	var myId = (typeof crypto !== 'undefined' && crypto.randomUUID)
		? crypto.randomUUID()
		: 'u-' + Math.random().toString(36).slice(2, 10);

	/**
	 * peers[peerId] = { el: HTMLElement, lastSeen: timestamp }
	 */
	var peers = {};
	var peerCleanupInterval = null;

	/* ── DOM refs ───────────────────────────────────────────────────────── */

	var lobby         = document.getElementById('lobby');
	var callInterface = document.getElementById('callInterface');
	var joinForm      = document.getElementById('joinForm');
	var lobbyError    = document.getElementById('lobbyError');
	var joinBtn       = document.getElementById('joinBtn');
	var callGrid      = document.getElementById('callGrid');
	var myAsciiEl     = document.getElementById('myAscii');
	var roomLabel     = document.getElementById('roomLabel');
	var statusText    = document.getElementById('statusText');
	var leaveBtn      = document.getElementById('leaveBtn');
	var muteBtn       = document.getElementById('muteBtn');

	/* ── Restore saved credentials ──────────────────────────────────────── */

	(function restoreSaved() {
		try {
			var saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
			if (saved) {
				if (saved.url)  document.getElementById('supabaseUrl').value = saved.url;
				if (saved.key)  document.getElementById('supabaseKey').value = saved.key;
				if (saved.room) document.getElementById('roomName').value    = saved.room;
			}
		} catch (_) { /* ignore */ }
	}());

	/* ── Lobby form ─────────────────────────────────────────────────────── */

	joinForm.addEventListener('submit', function (e) {
		e.preventDefault();
		hideLobbyError();

		var supabaseUrl = document.getElementById('supabaseUrl').value.trim();
		var supabaseKey = document.getElementById('supabaseKey').value.trim();
		var roomName    = document.getElementById('roomName').value.trim();

		if (!supabaseUrl || !supabaseKey || !roomName) {
			showLobbyError('Please fill in all fields.');
			return;
		}

		if (!/^https?:\/\/.+/.test(supabaseUrl)) {
			showLobbyError('Supabase URL must start with https://');
			return;
		}

		// Persist for this browser session so the user doesn't re-type
		try {
			sessionStorage.setItem(SESSION_KEY, JSON.stringify({
				url:  supabaseUrl,
				key:  supabaseKey,
				room: roomName
			}));
		} catch (_) { /* ignore */ }

		joinBtn.disabled = true;
		joinBtn.textContent = 'Connecting…';
		joinRoom(supabaseUrl, supabaseKey, roomName);
	});

	/* ── Leave / mute buttons ───────────────────────────────────────────── */

	leaveBtn.addEventListener('click', leaveCall);

	muteBtn.addEventListener('click', function () {
		feedPaused = !feedPaused;
		muteBtn.textContent = feedPaused ? 'Resume feed' : 'Pause feed';
	});

	/* ── Core: join a Supabase Realtime channel ─────────────────────────── */

	function joinRoom(supabaseUrl, supabaseKey, roomName) {
		try {
			var sb = window.supabase || window.Supabase;
			if (!sb || typeof sb.createClient !== 'function') {
				throw new Error('Supabase library not loaded. Check your internet connection.');
			}
			supabaseClient = sb.createClient(supabaseUrl, supabaseKey, {
				realtime: { params: { eventsPerSecond: 10 } }
			});
		} catch (err) {
			resetLobbyButton();
			showLobbyError('Could not initialise Supabase: ' + err.message);
			return;
		}

		var channelName = 'ascii-call:' + roomName;

		channel = supabaseClient.channel(channelName, {
			config: {
				broadcast: { self: false, ack: false },
				presence:  { key: myId }
			}
		});

		/* Receive ASCII frames from remote peers */
		channel.on('broadcast', { event: 'ascii-frame' }, function (msg) {
			var payload = msg.payload;
			if (!payload || payload.peerId === myId) return;
			updatePeer(payload.peerId, payload.ascii);
		});

		/* Presence – clean up peers that explicitly leave */
		channel.on('presence', { event: 'leave' }, function (msg) {
			var leftPresences = msg.leftPresences || [];
			leftPresences.forEach(function (p) {
				if (p.peerId) removePeer(p.peerId);
			});
		});

		channel.subscribe(function (status, err) {
			if (status === 'SUBSCRIBED') {
				channel.track({ peerId: myId });
				showCallInterface(roomName);
				startCamera();
				startPeerCleanup();
				setStatus('Connected · room: ' + roomName + ' · you: ' + myId.slice(0, 8));
			} else if (status === 'CHANNEL_ERROR') {
				handleSubscribeError(err || 'Channel error');
			} else if (status === 'TIMED_OUT') {
				handleSubscribeError('Connection timed out');
			} else if (status === 'CLOSED') {
				setStatus('Disconnected.');
			}
		});
	}

	function handleSubscribeError(err) {
		resetLobbyButton();
		showCallInterface(null); // keep lobby visible
		lobby.hidden = false;
		callInterface.hidden = true;
		showLobbyError('Connection failed: ' + (err.message || err) +
			'. Check your Supabase URL, anon key, and that Realtime is enabled.');
		if (channel) { channel.unsubscribe(); channel = null; }
	}

	/* ── Camera & ASCII ─────────────────────────────────────────────────── */

	function startCamera() {
		camera.init({
			width:   CAMERA_WIDTH,
			height:  CAMERA_HEIGHT,
			fps:     CAMERA_FPS,
			mirror:  true,
			onSuccess: function () {
				camera.start();
				cameraRunning = true;
			},
			onError: function () {
				setStatus('⚠ Camera error: could not access your camera.');
			},
			onNotSupported: function () {
				setStatus('⚠ getUserMedia not supported in this browser.');
			},
			onFrame: function (canvas) {
				ascii.fromCanvas(canvas, {
					contrast: 128,
					callback: function (asciiString) {
						if (!feedPaused) {
							myAsciiEl.textContent = asciiString;
							maybeBroadcast(asciiString);
						}
					}
				});
			}
		});
	}

	function maybeBroadcast(asciiString) {
		frameCount++;
		if (frameCount % BROADCAST_EVERY_N_FRAMES !== 0) return;
		if (!channel) return;

		channel.send({
			type:    'broadcast',
			event:   'ascii-frame',
			payload: { peerId: myId, ascii: asciiString }
		});
	}

	/* ── UI helpers ─────────────────────────────────────────────────────── */

	function showCallInterface(roomName) {
		resetLobbyButton();
		lobby.hidden = true;
		callInterface.hidden = false;
		if (roomName) roomLabel.textContent = 'Room: ' + roomName;
	}

	function showLobbyError(msg) {
		lobbyError.textContent = msg;
		lobbyError.hidden = false;
	}

	function hideLobbyError() {
		lobbyError.textContent = '';
		lobbyError.hidden = true;
	}

	function resetLobbyButton() {
		joinBtn.disabled = false;
		joinBtn.textContent = 'Join Room';
	}

	function setStatus(msg) {
		statusText.textContent = msg;
	}

	/* ── Peer management ────────────────────────────────────────────────── */

	function updatePeer(peerId, asciiString) {
		var now = Date.now();

		if (!peers[peerId]) {
			var feedEl = document.createElement('div');
			feedEl.className = 'feed';

			var labelEl = document.createElement('div');
			labelEl.className = 'feed-label';
			labelEl.textContent = 'Guest ' + peerId.slice(0, 8);

			var preEl = document.createElement('pre');
			preEl.className = 'feed-ascii peer-ascii-content';
			preEl.setAttribute('aria-label', 'Remote ASCII video feed');

			feedEl.appendChild(labelEl);
			feedEl.appendChild(preEl);
			callGrid.appendChild(feedEl);
			peers[peerId] = { el: feedEl, lastSeen: now };
		} else {
			peers[peerId].lastSeen = now;
		}

		peers[peerId].el.querySelector('.peer-ascii-content').textContent = asciiString;
	}

	function removePeer(peerId) {
		if (peers[peerId]) {
			peers[peerId].el.remove();
			delete peers[peerId];
		}
	}

	/**
	 * Periodically evict peers we haven't heard from in a while.
	 * This handles abrupt disconnects that don't trigger presence leave events.
	 */
	function startPeerCleanup() {
		peerCleanupInterval = setInterval(function () {
			var cutoff = Date.now() - PEER_TIMEOUT_MS;
			Object.keys(peers).forEach(function (id) {
				if (peers[id].lastSeen < cutoff) removePeer(id);
			});
		}, 5000);
	}

	/* ── Leave call ─────────────────────────────────────────────────────── */

	function leaveCall() {
		// Stop camera
		if (cameraRunning) {
			camera.stop();
			cameraRunning = false;
		}

		// Clear peer cleanup interval
		if (peerCleanupInterval) {
			clearInterval(peerCleanupInterval);
			peerCleanupInterval = null;
		}

		// Unsubscribe from channel
		if (channel) {
			channel.unsubscribe();
			channel = null;
		}
		supabaseClient = null;

		// Remove all remote peer feeds
		Object.keys(peers).forEach(removePeer);

		// Reset UI
		myAsciiEl.textContent = '';
		feedPaused   = false;
		frameCount   = 0;
		muteBtn.textContent = 'Pause feed';
		hideLobbyError();

		callInterface.hidden = true;
		lobby.hidden = false;
	}

}());
