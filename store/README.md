# Noggin

Noggin is a new AI brain for Jibo. Open it and talk with Jibo: he listens, answers in his own voice, moves with what he says, and uses his own skills along the way.

Noggin needs BEam 3.1.9 or newer, an internet connection and your own OpenAI API key.

![Noggin: a white brain with a blue and an orange glow](banner.png)

## Getting started

1. Install Noggin. Then, on a phone or computer on the same network as Jibo, open the address you use for BEacon with **8131** instead of 8123, for example http://192.168.1.20:8131.
2. On the **Brain** tab, paste your OpenAI API key and tap **Save**. **Test key** checks it with OpenAI first.
3. Tap **Noggin** in Jibo's menu and say hello.

No key yet? Open Noggin anyway: Jibo shows a QR code on his screen that takes your phone straight to the Brain tab. Once you save the key, he starts talking.

## Talking with Jibo

- Jibo says hi as soon as Noggin opens. His ring is **blue** while he listens and **orange** while he thinks and talks.
- Talk normally and wait for his answer. He does not hear you while he speaks.
- Say **goodbye** to end, swipe down, or stay quiet for a minute.
- When something is wrong, Jibo tells you in his own words: no internet, OpenAI not answering, no credit left on your OpenAI account, or a key or setting that needs a look (then he shows the QR code to his settings page). If the connection drops for a moment, he reconnects once and carries on.
- With an admin key saved, Jibo gives you a heads-up after his greeting, once a day, when only 10% of your OpenAI spend limit is left (change or switch it off on the Usage tab).

During a conversation Jibo can tell you the time and date on his clock, set and cancel timers and alarms, change his volume, dance, play music and the radio, take a photo, open his apps, and ask his cloud for the weather, the news, your calendar, your commute, a personal report, a surprise or a picture of something. When another skill or app takes over, Noggin comes back afterwards with "Anything else?" (within 5 minutes; you can change that). Music and the radio end the conversation.

Jibo remembers. After a conversation he keeps a short note of it for two weeks, and the facts worth keeping about your household (names, pets, likes, plans), so he can come back to them next time. Say "remember that…", "forget that…" or "what did we talk about last week?" to ask him directly. Several people talk to Jibo and he cannot tell who is who, so what he remembers is shared by the whole household; he leaves out health details, codes, money, addresses and anything you ask him to keep secret.

## The settings page

The page has seven tabs. Changes apply to the next conversation.

- **Brain:** your OpenAI key and the models Noggin uses.
- **Persona:** who Jibo is: his soul, his identity and more facts about him. Everything can be changed, and **Reset to default** brings back Noggin's own text. The default persona keeps every answer right for a young child.
- **Behaviour:** the greeting, when a conversation ends, expressions and dances. Advanced settings for the microphone are folded away.
- **Skills:** which of Jibo's skills and cloud features Noggin may use, and up to 8 extra apps it may open by name, each with a line on what it does so Noggin knows when to open it. Scan finds the skills you installed through BEacon and fills in that line from their description; add each with one click.
- **Memory:** the facts Jibo keeps and his notes of recent conversations: add, change or delete them, export them, or make him forget everything. Switch memory, or learning from conversations, off here.
- **Usage:** what Jibo costs on your OpenAI account: this month and what is left of your OpenAI budget, a forecast, the cost per conversation, the last 7 days per day and per model (with what Noggin uses each model for), what caching saved, and when Jibo is used. It needs an OpenAI admin key with **Read only** permission from the same organization as Jibo's key; Jibo checks that the key cannot change anything and refuses any other. Jibo asks OpenAI only when you open the tab or press Refresh.
- **History:** recent conversations as text, to read or download. Never audio, never the key.

The settings page has no password, like BEacon: anyone on your home network can open it. They can read the conversation history and what Jibo remembers, change settings and make him forget, and see the Usage tab. The keys are never shown again once saved.

## Privacy

What you say goes to OpenAI to be answered, with your key. Noggin keeps conversation logs on Jibo as text, readable by anyone on your home network through the settings page; turn them off on the History tab if that is not what you want. The logs themselves are sent nowhere.

With **Learn from conversations** on (the default), each finished conversation's text and the facts Jibo keeps go to OpenAI once more, so a small model can write the note and pick out facts. The notes and facts stay on Jibo. With conversation logs off, Jibo keeps only what was said until that note is written. Turn learning off on the Memory tab and Jibo only remembers what you ask him to; turn memory off and he remembers nothing.

With an admin key saved, Jibo reads your account's costs, usage and spend limits from OpenAI when you open the Usage tab, and twice a day for the budget heads-up, and keeps them in memory for 15 minutes. He never keeps or shows the account's users, and never sees other keys' secrets.
