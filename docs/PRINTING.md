# Thermal printing and local bridge

## Browser baseline

Under Menu & setup → Printers configure branch destination and width (58 or 80 mm). For kitchen/bar choose the preparation station; customer receipts use destination `bill`. Confirmed rounds queue one job per station using only that round's items. New rounds have NEW/ADDITION indicators; cancellations and explicit reprints have their own indicators. Print payloads snapshot branch/table/station, item details and order taker attribution. Customer receipts snapshot totals, named charges, payments, balance, change, takers and payment receiver/cashier information.

The print queue dispatches to `window.print()`. This opens a browser dialog; it is **not silent printing** and it does not establish physical output. Selecting Cancel still means the browser dispatch happened. Record an ambiguous/failed result and explicitly inspect the queue/printer before retry. Printing never changes payment state. Each explicit reprint creates a new unique job and logs who requested it while preserving historical order-taker snapshots.

Use correct printer drivers, paper width and margins. Turn off browser URL headers/footers in the browser print dialog. The print CSS has compact monospace layouts and hides the staff application. Browser results depend on the actual printer/driver; test both paper sizes with your hardware.

## Optional unattended ESC/POS TCP bridge

`scripts/print-bridge.mjs` is a local polling bridge for a compatible ESC/POS printer accepting raw TCP, commonly port 9100. Run it on a trusted restaurant LAN machine that can reach both the HTTPS API and the printer. Do not expose the printer port to the public Internet. USB/Bluetooth printers need their vendor driver or a separate supported transport; this bridge does not implement those protocols.

Configure environment variables **on that local machine**:

```sh
export API_URL=https://your-restaurant-api.example/api
export BRIDGE_EMAIL=dedicated-print-user@example.test
export BRIDGE_PASSWORD='set securely on the local machine'
export BRIDGE_BRANCH_ID=branch-uuid
export BRIDGE_DESTINATION=station-uuid
export PRINTER_HOST=192.168.1.50
export PRINTER_PORT=9100
node scripts/print-bridge.mjs
```

Use destination `bill` for a receipt bridge, or a station UUID returned by the authorized preparation-station API for a kitchen/bar bridge. Use a dedicated active staff identity with branch and station access and only the needed order-view/receipt permissions; do not use a platform administrator. The bridge signs in, polls persisted jobs and transactionally claims a queued job before touching hardware. Competing claims fail. Refresh/authentication uses normal staff authentication and revocation. Keep credentials out of source and shell history.

A socket write/close is **dispatch**, not physical confirmation. On transport failure the bridge records an ambiguous failed state and never automatically prints that failed job again. Staff must inspect physical output and choose retry/reprint explicitly. A crash after claiming and before writing leaves a dispatched job requiring manual inspection. This conservative behavior avoids blindly duplicating kitchen tickets.

Text is control-character sanitized before producing ESC/POS commands. The sample uses UTF-8, which may not match a printer's code page; test names/languages, cut commands and paper width against the exact printer model. The bridge has not been verified on physical hardware in this environment. No claims of physical output, silent browser printing or USB support are made.

## Deployment checks

Test NEW, ADDITION, CANCELLATION, reprint, split-payment receipt, canceled browser dialog, powered-off printer, network drop during send, and bridge restart after claim. Confirm that an accepted order stays in PostgreSQL and remains visible even when printing fails. Keep explicit operator procedures for ambiguous output. Printer settings do not store card data or financial credentials.
