// The reminder service (InkTasks/worker, on Cloudflare). Empty = no service: reminders then only
// show while InkTasks is open. The local test server swaps these for a service on this computer.
export const REMINDER_SERVICE = "https://inktasks-reminders.tasklist.workers.dev";
// The service's public VAPID key (base64url). Not a secret: browsers use it to check that pushes
// come from the service.
export const VAPID_PUBLIC = "BAO-53ySkHWPQ54gdLPm2bU8gKJ8Mr-yCAo229c3yWeVDwqFjv4Y6QnKWmvpbLyac4Eii1juAdSg0jfxnZsZ27U";
