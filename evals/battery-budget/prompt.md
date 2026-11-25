---
max_turns: 20
allowed_tools: [Read, Glob, Grep, Skill]
runs: 3
model: sonnet
tags: [budget]
---
Our battery door sensor lasts about 5 months on one CR2032 coin cell (220 mAh usable). Product wants at least a year, without dropping any feature. Here is the current design:

- MCU: active 3.0 mA, sleep 2 uA. It wakes every 1 s to poll the reed switch and stays awake 10 ms each time.
- Radio (BLE): 8 mA while on. On every door event it connects and sends (40 ms). Every 1 s it also advertises for 3 ms so the phone app sees it is alive.
- Status LED: 2 mA, lit for 2 s on every door event.
- Temperature sensor: 0.5 mA, read every 10 s, 20 ms per read, value is sent with the next heartbeat.
- Heartbeat: every 5 min the radio connects and sends status (40 ms).
- About 60 door events per day.
- Self-discharge and leakage: about 1% of capacity per year.

Features that must stay: open/close notified to the app within 2 seconds, the app sees the sensor is alive within 15 minutes, the LED confirms each door event, temperature in the app accurate to within 10 minutes.

Where does the energy go, and what should we change to reach a year? I need numbers.
