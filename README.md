# spur-phone

A Twilio number and an ElevenLabs voice agent that call businesses and report back.

A [Switch](https://switch.ax) spur: a Python MCP server (`sbmcp.py`, a Switchboard appendage) that Switch runs through
[spur-kit](https://github.com/zachsents/spur-kit)'s shim. Its messages carry who sent them, for Switch's inbox and Contacts.

## Install

Ask Switch's agent to install `github:zachsents/spur-phone`, or add it in the desktop's Spurs view (⌘K, Spurs). Switch runs it
on the first machine with what it needs (`always-on`).

## Setup

Put a `secrets.json` in its `home` once, with `twilio_sid`, `twilio_token`, `eleven_key`, `line` (the number, E.164), `agent_id`, `callback_agent_id` and `phone_number_id`: on its next call the keys go to Switch's connections (Twilio's named by its SID), and the rest stays as `config.json`. Calls name the user from `config.json`'s `name` and `name_ja` (how to say it in Japanese), else from My Card in Contacts on the Mac it runs on (nickname or first name, and phonetic first name).
