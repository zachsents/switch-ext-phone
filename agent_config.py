"""The ElevenLabs agent behind Switch's phone line: one agent, re-briefed per call through overrides."""

JA_VOICE = "G3EZ8O36A0x9lmeOtr0f"   # Kaori: clear, friendly, conversational Japanese
EN_VOICE = "cgSgspJ2msm6clMCkdW9"   # Switch's own voice (the island's)
LLM = "gemini-3.5-flash"

def agent_body(name="Switch phone (calls businesses for the user)"):
    return {
        "name": name,
        "tags": ["switchboard", "phone-call"],
        "conversation_config": {
            "asr": {"quality": "high", "provider": "scribe_realtime", "user_input_audio_format": "ulaw_8000"},
            # A business going quiet while it looks something up or makes a change is normal, so silence ends a call
            # only after three minutes: 25 seconds hung up on Catalina Express mid-change (Nov 13).
            "turn": {"turn_timeout": 8.0, "mode": "turn", "turn_eagerness": "patient", "silence_end_call_timeout": 180.0},
            "tts": {"model_id": "eleven_v4_turbo", "voice_id": JA_VOICE, "agent_output_audio_format": "ulaw_8000",
                    "optimize_streaming_latency": 3, "stability": 0.55, "speed": 1.0, "similarity_boost": 0.8},
            "conversation": {"max_duration_seconds": 480},
            "agent": {
                "first_message": "",
                "language": "ja",
                "disable_first_message_interruptions": False,
                "prompt": {
                    "prompt": "You are placing a phone call for the user. The call's brief arrives with each call.",
                    "llm": LLM,
                    "temperature": 0.3,
                    "built_in_tools": {
                        "end_call": {"name": "end_call", "description": "", "params": {"system_tool_type": "end_call"}},
                        "play_keypad_touch_tone": {"name": "play_keypad_touch_tone", "description": "", "params": {"system_tool_type": "play_keypad_touch_tone"}},
                        "skip_turn": {"type": "system", "name": "skip_turn", "description": "Stay silent while they've put you on hold, transferred you, or asked you to wait while they check or make a change.", "params": {"system_tool_type": "skip_turn"}},
                        "voicemail_detection": {"name": "voicemail_detection", "description": "", "params": {"system_tool_type": "voicemail_detection", "voicemail_message": ""}},
                    },
                },
            },
        },
        "platform_settings": {
            "overrides": {
                "conversation_config_override": {
                    "agent": {"first_message": True, "language": True, "prompt": {"prompt": True}},
                    "tts": {"voice_id": True},
                    "asr": {"keywords": True},
                    "conversation": {"max_duration_seconds": True},
                }
            },
            "data_collection": {
                "answer": {"type": "string", "description": "WRITE IN ENGLISH ONLY. The answer the caller was sent to get, as the person on the phone stated it: availability, numbers, times (24h), prices in yen, conditions. Where they corrected a figure, give the corrected one. If it wasn't obtained, say why (no answer, voicemail, closed, refused, didn't know)."},
                "unsure": {"type": "string", "description": "WRITE IN ENGLISH ONLY. Any figure or fact that was garbled, contradicted, or not clearly confirmed by the person on the phone, with the competing versions. Empty if everything was clearly confirmed."},
                "reached_human": {"type": "boolean", "description": "True if a live person answered and spoke with the caller."},
                "charged_total": {"type": "number", "description": "The total the caller agreed to pay, or that the person on the phone said they charged or will charge, on this call: every fee, fare or price difference, tax and separate charge added together, as a plain number in the call's currency (14 for $14, 3000 for 3,000 yen). 0 if nothing was agreed or charged."},
                "completed": {"type": "boolean", "description": "True only if the person on the phone said the booking, change or order was done (not just being made) before the call ended. False for calls that only asked questions."},
            },
        },
    }


CALLBACK_PROMPT = """You answer the phone line {name}'s AI assistant, Switch, calls businesses from. Whoever calls is most likely a business calling back about a question Switch asked earlier (bike rentals, restaurants, hotels, shops), or occasionally someone else.

- You're an AI assistant taking a message for {name}. Say so if asked.
- Find out: who's calling (name and business), what it's about, the details they want to pass on (availability, times, prices, conditions), and a number to call back. Repeat the key facts back once.
- Don't make, confirm or cancel bookings, and don't promise anything. Say {name} will get the message right away and get back to them.
- Speak the caller's language: polite Japanese (敬語) by default, English if they speak English. Keep turns short.
- If it's a sales call, a robocall or silence, end the call politely.
- When you have the message, thank them and end the call."""


def callback_body(name, name_ja):
    """The callback agent, which greets and takes messages for the user: name is how callers hear them, name_ja its
    Japanese reading (common.caller_name)."""
    body = agent_body("Switch phone: callbacks (takes messages)")
    agent = body["conversation_config"]["agent"]
    agent["first_message"] = f"お電話ありがとうございます。{name_ja}のAIアシスタントです。ご用件を承ります。"
    agent["prompt"]["prompt"] = CALLBACK_PROMPT.format(name=name)
    agent["prompt"]["built_in_tools"]["language_detection"] = {"name": "language_detection", "description": "", "params": {"system_tool_type": "language_detection"}}
    del agent["prompt"]["built_in_tools"]["play_keypad_touch_tone"]
    body["conversation_config"]["language_presets"] = {
        "en": {"overrides": {"agent": {"first_message": f"Hi, this is {name}'s AI assistant. How can I help?", "language": "en"},
                             "tts": {"voice_id": EN_VOICE}}}}
    body["conversation_config"]["conversation"]["max_duration_seconds"] = 300
    body["platform_settings"]["data_collection"] = {
        "caller": {"type": "string", "description": "Who called: their name and business, as they gave it."},
        "message": {"type": "string", "description": "Their message for the user in English, with every detail they gave (availability, times, prices, conditions)."},
        "callback_number": {"type": "string", "description": "A number they gave to call back, if any."},
    }
    return body
