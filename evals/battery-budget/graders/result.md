---
type: llm
focus: last_message
weight: 3
---
Reference arithmetic (approximate, mAh per day): MCU polling 3 mA x 10 ms every 1 s = 30 uA, about 0.72 (about half); BLE advertising 8 mA x 3 ms every 1 s = 24 uA, about 0.58 (about 40%); LED 60 x 2 mA x 2 s, about 0.067; sleep 2 uA, about 0.048; heartbeats about 0.026; temperature about 0.024; door-event radio about 0.005; self-discharge about 0.006. Total about 1.47 mAh/day, about 150 days. Fixing polling alone (wake on the reed switch interrupt) gives about 290 days, not a year; advertising must also be slowed (the app only needs to see it alive within 15 minutes), after which the life is several years and sleep current and LED dominate.
PASS only if the answer:
1. Itemizes energy per component with numbers (average current or charge per day) and shows which items are largest. Small arithmetic differences are fine.
2. Identifies the two big items (MCU polling every second, BLE advertising every second) as the main fixes, e.g. waking on the reed switch interrupt and advertising far less often within the 15 minute alive requirement.
3. Keeps every required feature (2 s notify, 15 min alive, LED per event, 10 min temperature) or clearly names any that a change would weaken as a trade-off for the user.
4. Gives a resulting battery life estimate that reaches or exceeds one year, with the main assumption stated.
FAIL if it drops a required feature silently, or gives no numbers.
