// Checks what the add-task box understands. Run: node test/parse.test.mjs
// "Now" is Monday 23 November 2026, 10:00.
import assert from "node:assert/strict";
import { parseTask } from "../app/js/parse.js";

const now = new Date(2026, 10, 23, 10, 0);
const lists = [{ id: "L1", name: "Groceries" }, { id: "L2", name: "Bills" }, { id: "L3", name: "Work stuff" }];
const p = (text, keep) => parseTask(text, { now, lists, keep });
let passed = 0, failed = 0;
function check(text, want, keep) {
  const got = p(text, keep);
  const picked = Object.fromEntries(Object.keys(want).map(k => [k, got[k]]));
  try { assert.deepEqual(picked, want); passed++; }
  catch (_) { failed++; console.log(`FAIL "${text}"\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(picked)}`); }
}

// plain text stays plain
check("Buy milk", { title: "Buy milk", due: null, remind: null, repeat: null, listId: null, important: false });
check("Buy 5 apples", { title: "Buy 5 apples", due: null, remind: null });
check("Read 1984", { title: "Read 1984", due: null });
check("Plan evening walk", { title: "Plan evening walk", remind: null });
check("Sun cream", { title: "Sun cream", due: null });
check("SAT prep", { title: "SAT prep", due: null });
check("Get wed photos", { title: "Get wed photos", due: null });
check("Brunch on sat", { title: "Brunch", due: "2026-11-28" });
check("Wedding gift", { title: "Wedding gift", due: null });
check("Meeting at the office", { title: "Meeting at the office", remind: null });
check("Email the monday group", { due: "2026-11-23", title: "Email the group" });   // a day name is a date; tap the chip to keep it

// dates
check("Call mom today", { title: "Call mom", due: "2026-11-23", myDay: "2026-11-23" });
check("Call mom tomorrow", { title: "Call mom", due: "2026-11-24", myDay: null });
check("Dentist day after tomorrow", { title: "Dentist", due: "2026-11-25" });
check("Submit report by Friday", { title: "Submit report", due: "2026-11-27" });
check("Submit report on Fri", { title: "Submit report", due: "2026-11-27" });
check("Team lunch next Friday", { title: "Team lunch", due: "2026-12-04" });
check("Haircut monday", { title: "Haircut", due: "2026-11-23" });
check("Haircut next monday", { title: "Haircut", due: "2026-11-30" });
check("Renew passport Dec 5", { title: "Renew passport", due: "2026-12-05" });
check("Renew passport on December 5th, 2027", { title: "Renew passport", due: "2027-12-05" });
check("Tax stuff 15 April", { title: "Tax stuff", due: "2027-04-15" });
check("Party 12/31", { title: "Party", due: "2026-12-31" });
check("Party 1/2/27", { title: "Party", due: "2027-01-02" });
check("Pay card on the 1st", { title: "Pay card", due: "2026-12-01" });
check("Pay card the 30th", { title: "Pay card", due: "2026-11-30" });
check("Follow up in 3 days", { title: "Follow up", due: "2026-11-26" });
check("Follow up in a week", { title: "Follow up", due: "2026-11-30" });
check("Plan trip next week", { title: "Plan trip", due: "2026-11-30" });
check("Feb 30 thing", { due: null, title: "Feb 30 thing" });

// times -> reminders
check("Call mom tomorrow at 5", { title: "Call mom", due: "2026-11-24", remind: "2026-11-24T17:00" });
check("Call mom at 5pm", { title: "Call mom", due: null, remind: "2026-11-23T17:00" });
check("Standup 9am", { title: "Standup", due: null, remind: "2026-11-24T09:00" });   // 9am has passed today
check("Pills at 21:30", { title: "Pills", remind: "2026-11-23T21:30" });
check("Lunch with Sam friday at noon", { title: "Lunch with Sam", due: "2026-11-27", remind: "2026-11-27T12:00" });
check("Remind me to call Bob at 3:15pm", { title: "call Bob", remind: "2026-11-23T15:15" });
check("Take out trash tonight", { title: "Take out trash", due: "2026-11-23", remind: "2026-11-23T20:00" });
check("Gym tomorrow morning", { title: "Gym", due: "2026-11-24", remind: "2026-11-24T09:00" });
check("Check oven in 30 minutes", { title: "Check oven", remind: "2026-11-23T10:30" });
check("Check oven in 2 hours", { title: "Check oven", remind: "2026-11-23T12:00" });

// repeats
check("Water plants every day", { title: "Water plants", repeat: { unit: "day", every: 1 }, due: "2026-11-23" });
check("Water plants daily at 8am", { title: "Water plants", repeat: { unit: "day", every: 1 }, due: "2026-11-23", remind: "2026-11-23T08:00" });
check("Standup every weekday", { title: "Standup", repeat: { unit: "week", every: 1, days: [1, 2, 3, 4, 5] } });
check("Trash every Tuesday", { title: "Trash", repeat: { unit: "week", every: 1, days: [2] }, due: "2026-11-24" });
check("Gym every mon, wed and fri at 6pm", { title: "Gym", repeat: { unit: "week", every: 1, days: [1, 3, 5] }, due: "2026-11-23", remind: "2026-11-23T18:00" });
check("Clean fridge every other week", { title: "Clean fridge", repeat: { unit: "week", every: 2 } });
check("Haircut every 6 weeks", { title: "Haircut", repeat: { unit: "week", every: 6 } });
check("Pay rent every month on the 1st at 9am #bills", { title: "Pay rent", repeat: { unit: "month", every: 1 }, due: "2026-12-01", remind: "2026-12-01T09:00", listId: "L2" });
check("Birthday card yearly Dec 5", { title: "Birthday card", repeat: { unit: "year", every: 1 }, due: "2026-12-05" });

// lists and importance
check("Milk #groceries", { title: "Milk", listId: "L1" });
check("Milk #groc", { title: "Milk", listId: "L1" });
check("Milk #nope", { title: "Milk #nope", listId: null });
check("Slides for review in work stuff", { title: "Slides for review", listId: "L3" });
check("Eggs in the groceries list", { title: "Eggs", listId: "L1" });
check("Fix the leak ! tomorrow", { title: "Fix the leak", important: true, due: "2026-11-24" });
check("Wow! great", { important: false, title: "Wow! great" });

// keeping a phrase as text
check("Call about Friday's meeting", { title: "Call about Friday's meeting", due: null }, ["friday"]);
check("Read The Day After Tomorrow", { title: "Read The Day After Tomorrow", due: null }, ["the day after tomorrow"]);

// chips describe what was found
const c = p("Pay rent every month on the 1st at 9am #bills").chips.map(x => x.kind);
assert.deepEqual(c, ["repeat", "date", "time", "list"]); passed++;

console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}`);
if (failed) process.exit(1);
