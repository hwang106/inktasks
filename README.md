# InkTasks

Task lists (My Day, Important, Planned, your own lists; steps, notes, due dates, repeats) that
sync through your own OneDrive, end-to-end encrypted. Companion to
[InkNotes](https://github.com/hwang106/inknotes): both live on the same site, share one sign-in
and one sync passphrase, and InkNotes' "Make task" drops tasks straight in here.

- Live: https://hwang106.github.io/inktasks/
- Imports Microsoft To Do once (read-only), safe to repeat.
- Uses InkNotes' sign-in and sync modules from `/inknotes/js/`, so it must be served next to it.
- Local: run `node dev-server.js` in the InkNotes repo and open http://localhost:5173/inktasks/
  (add `--fake-ms --port=5174` to test sync and import without a real account).
