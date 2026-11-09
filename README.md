# PayPal standard integration sample, packaged for Sherpa

This is **PayPal's official JavaScript SDK standard-integration sample**, taken from
[paypal-examples/docs-examples](https://github.com/paypal-examples/docs-examples/tree/809537903a2c38757d33cd871465741c610088cd/standard-integration)
at commit `8095379` (Apache-2.0, see `LICENSE`). It is the code many merchants start from.

We use it to test [Sherpa](https://github.com/nnam-droid12/Sherpa) on a PayPal integration we did not write.

## What we changed to package it

The PayPal code is otherwise unchanged:

- `client/index.html` and `client/app.js` are the sample's `client/html/src` files, unchanged.
- `server.js` is the sample's `server/node/server.js`, plus one block that serves the `client` folder and
  injects `PAYPAL_CLIENT_ID` into the page (the original sample used Vite's dev server for this).
- `package.json` keeps the sample server's dependencies, with a `start` script.
- Added a `Dockerfile` so it runs as one Cloud Run service.

## Run it

```bash
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npm install && npm start
```

Sandbox only. Any changes after this commit come from Sherpa's pull requests.
