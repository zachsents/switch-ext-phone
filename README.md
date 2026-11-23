# switch-ext-phone

A Twilio number and an ElevenLabs voice agent that call businesses and report back.

A [Switch](https://switch.ax) extension in TypeScript and Effect on [switch-ext-kit](https://github.com/zachsents/switch-ext-kit). Its messages carry who sent them, for Switch's inbox and Contacts.

## Install

Ask Switch's agent to install `github:zachsents/switch-ext-phone`, or add it in the desktop's Extensions view (⌘K, Extensions). Switch runs it
on the first machine with what it needs (`always-on`).

## Setup

Put a `secrets.json` in its `home` once, with `twilio_sid`, `twilio_token`, `eleven_key`, `line` (the number, E.164), `agent_id`, `callback_agent_id` and `phone_number_id`: on its next call the keys go to Switch's connections (Twilio's named by its SID), and the rest stays as `config.json` (its `twilio_sid` names the account the token is for). Calls name the user from `config.json`'s `name` and `name_ja` (how to say it in Japanese), else from My Card in Contacts on the Mac it runs on (nickname or first name, and phonetic first name).
