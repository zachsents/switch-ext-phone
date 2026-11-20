# spur-phone

A Twilio number and an ElevenLabs voice agent that call businesses and report back.

A [Switch](https://switch.ax) spur: a Python MCP server (`sbmcp.py`, a Switchboard appendage) that Switch runs through
[spur-kit](https://github.com/zachsents/spur-kit)'s shim. Its messages carry who sent them, for Switch's inbox and Contacts.

## Install

Ask Switch's agent to install `github:zachsents/spur-phone`, or add it in the desktop's Spurs view (⌘K, Spurs). Switch runs it
on the first machine with what it needs (`always-on`).

## Setup

Set `PHONE_TWILIO_SID` and `PHONE_LINE` (the number, E.164) in the spur's environment. Put a `secrets.json` in its `home` once, with `twilio_token`, `eleven_key`, `agent_id`, `callback_agent_id` and `phone_number_id`: on its next start the keys go to Switch's connections, and the ids stay as `config.json`.
