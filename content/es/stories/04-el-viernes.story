[DATA]
id=04-el-viernes
language=es
unit=16
fromLanguageName=Friday
author=Codex P6 author
narrator_register=tu
cover=stories/04-el-viernes/cover.png

[HEADER]
> El viernes

[LINE]
Speakeradult_female: ¿Cuándo es la reunión?
= When is the meeting?

[LINE]
Speakeradult_male: El viernes.
= On Friday.

[LINE]
Speakeradult_female: ¿A qué hora?
= At what time?

[LINE]
Speakeradult_male: A las nueve.
= At nine.

[LINE]
Speakeradult_female: Quiero llegar temprano.
= I want to arrive early.

[MULTIPLE_CHOICE]
> On which day is the meeting?
@tags=viernes
+ Friday.
- Thursday.
- Monday.

[LINE]
Speakeradult_male: La oficina abre a las ocho.
= The office opens at eight.

[LINE]
Speakeradult_female: Puedo esperar dentro.
= I can wait inside.

[LINE]
Speakeryoung: ¿La reunión es hoy?
= Is the meeting today?

[CONTINUATION]
> Select the missing word or phrase
Speakeradult_male: La reunión es [mañana].
= The meeting is tomorrow.
@tags=mañana
+ mañana
- ayer
- siempre

[LINE]
Speakeradult_female: Sí. Es viernes.
= Yes. It is Friday.

[LINE]
Speakeryoung: Hoy es jueves.
= Today is Thursday.

[LINE]
Speakeradult_female: ¿Jueves?
= Thursday?

[ARRANGE]
> Tap what you hear
Speakeryoung: [(Hoy) (es) (jueves)].
= Today is Thursday.
@tags=jueves

[LINE]
Speakeradult_male: Sí. La reunión es mañana.
= Yes. The meeting is tomorrow.

[LINE]
Speakeradult_female: Entonces estoy muy temprano.
= Then I am very early.

[LINE]
Speakeryoung: ¿Quieres café?
= Do you want coffee?

[POINT_TO_PHRASE]
> Select the meaning for “early”
Speakeradult_female: Quiero (llegar) (+temprano).
= I want to arrive early.
@tags=temprano

[LINE]
Speakeradult_female: Sí, por favor.
= Yes, please.

[LINE]
Speakeradult_male: El café está listo hoy.
= The coffee is ready today.

[MULTIPLE_CHOICE]
> Why is Rosa early?
@tags=temprano
+ She arrived a day before the meeting.
- The meeting was cancelled.
- The office is closed forever.

[MATCH]
- viernes <> Friday
- reunión <> meeting
- temprano <> early
- jueves <> Thursday
- mañana <> tomorrow
