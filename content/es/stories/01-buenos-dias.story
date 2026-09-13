[DATA]
id=01-buenos-dias
language=es
unit=1
fromLanguageName=Good morning
author=Codex P6 author
narrator_register=tu
cover=stories/01-buenos-dias/cover.png

[HEADER]
> Buenos días

[LINE]
Speakeradult_female: Hola.
= Hello.

[LINE]
Speakeryoung: Buenas noches.
= Good evening.

[LINE]
Speakeradult_female: ¿Buenas noches?
= Good evening?

[LINE]
Speakeryoung: No. Buenos días.
= No. Good morning.

[LINE]
Speakeradult_female: Sí. Buenos días.
= Yes. Good morning.

[MULTIPLE_CHOICE]
> Which greeting does Nico use first?
@tags=noche
+ Good evening.
- Good morning.
- Goodbye.

[LINE]
Speakeryoung: ¿Cómo?
= What?

[LINE]
Speakeradult_female: Buenos días.
= Good morning.

[LINE]
Speakeryoung: Gracias.
= Thank you.

[CONTINUATION]
> Select the missing word or phrase
Speakeryoung: Buenos [días].
= Good morning.
@tags=día
+ días
- nombres
- apellidos

[LINE]
Speakeradult_female: ¿Cómo estás?
= How are you?

[LINE]
Speakeryoung: Bien. ¿Y tú?
= Well. And you?

[LINE]
Speakeradult_female: Bien.
= Well.

[ARRANGE]
> Tap what you hear
Speakeryoung: [(Mucho) (gusto)].
= Nice to meet you.
@tags=gusto

[LINE]
Speakeryoung: Mucho gusto.
= Nice to meet you.

[LINE]
Speakeradult_female: Encantada.
= Pleased to meet you.

[LINE]
Speakeryoung: ¿Adiós?
= Goodbye?

[POINT_TO_PHRASE]
> Select the meaning for “later”
Speakeradult_female: (Hasta) (+luego).
= See you later.
@tags=luego

[LINE]
Speakeradult_female: No. Hasta luego.
= No. See you later.

[LINE]
Speakeryoung: Hasta luego.
= See you later.

[MULTIPLE_CHOICE]
> What does Rosa say at the end?
@tags=luego
+ See you later.
- Good evening.
- Goodbye forever.

[MATCH]
- día <> day
- noche <> night
- gracia <> thanks
- gusto <> pleasure
- luego <> later
