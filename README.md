ASCII Camera
============

ASCII Camera uses the HTML5 getUserMedia API to transform a video stream from your webcam into a real-time ASCII representation.

**[See it in action](https://andrei.codes/ascii-camera/)**.

<img src="https://andrei.codes/images/ascii-screenshot.png" />

## ASCII Video Call (new!)

Connect with others in real time using ASCII video — no plugins, no heavyweight media servers.
Calls are brokered through [Supabase Realtime](https://supabase.com/realtime) (broadcast channels), so each participant's ASCII frames are pushed to everyone else in the same room.

### Quick start

1. **Create a free Supabase project** at <https://supabase.com/dashboard>.
2. Go to **Project Settings → API** and copy your **Project URL** and **Anon / public key**.
3. Confirm that **Realtime** is enabled (it is by default on new projects).
4. Open `call.html`, paste those two values, pick a room name, and click **Join Room**.
5. Share the room name with friends so they can join.

> No database tables are required. The feature uses only ephemeral Realtime broadcast channels.

**Need more detail?** See the [step-by-step Supabase setup guide](SUPABASE_SETUP.md) for
screenshots, descriptions, troubleshooting tips, and free-tier usage estimates.

## Supported browsers

* Chrome &ge; 21
* Firefox &ge; 17 (requires `media.navigator.enabled = true` in `about:config`)
* Opera &ge; 12

## Libraries used

* Camera input is done using the [camera.js library](https://github.com/idevelop/camera.js).
* ASCII transformation is adapted from [jsascii library](http://www.nihilogic.dk/labs/jsascii/) by [Jacob Seidelin](http://blog.nihilogic.dk/).
* Video call signalling uses [Supabase Realtime](https://supabase.com/realtime) (`@supabase/supabase-js` v2, loaded from jsDelivr CDN).

## Author

**Andrei Gheorghe**

* [About me](https://andrei.codes)
* LinkedIn: [linkedin.com/in/idevelop](http://www.linkedin.com/in/idevelop)
* Twitter: [@idevelop](http://twitter.com/idevelop)

## License

- This code is licensed under the MIT License.
