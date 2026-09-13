[DATA]
id=05-el-paraguas
language=es
unit=18
fromLanguageName=The umbrella
author=Codex P6 author
narrator_register=tu
cover=stories/05-el-paraguas/cover.png

[HEADER]
> El paraguas

[LINE]
Speakeryoung: Llueve mucho.
= It is raining a lot.

[LINE]
Speakeradult_female: ¿Dónde está tu paraguas?
= Where is your umbrella?

[LINE]
Speakeryoung: En la cocina.
= In the kitchen.

[LINE]
Speakeradult_female: ¿En la cocina?
= In the kitchen?

[LINE]
Speakeryoung: Sí. Está abierto.
= Yes. It is open.

[MULTIPLE_CHOICE]
> Where is the open umbrella?
@tags=cocina
+ In the kitchen.
- In the garden.
- At the office.

[LINE]
Speakeradult_female: ¿Por qué está abierto?
= Why is it open?

[LINE]
Speakeryoung: El grifo no está cerrado.
= The tap is not closed.

[LINE]
Speakeradult_female: Podemos cerrar el grifo.
= We can close the tap.

[CONTINUATION]
> Select the missing word or phrase
Speakeryoung: El grifo no está [cerrado].
= The tap is not closed.
@tags=grifo
+ cerrado
- lleno
- frío

[LINE]
Speakeryoung: No puedo. Está muy duro.
= I cannot. It is very stiff.

[LINE]
Speakeradult_female: Puedo ayudarte.
= I can help you.

[LINE]
Speakeryoung: Gracias.
= Thank you.

[ARRANGE]
> Tap what you hear
Speakeradult_female: [(Podemos) (cerrar) (el) (grifo)].
= We can close the tap.
@tags=grifo

[LINE]
Speakeradult_female: El grifo está cerrado.
= The tap is closed.

[LINE]
Speakeryoung: ¿Y el paraguas?
= And the umbrella?

[LINE]
Speakeradult_female: Está aquí.
= It is here.

[POINT_TO_PHRASE]
> Select the meaning for “umbrella”
Speakeryoung: Mi (+paraguas) está en la (cocina).
= My umbrella is in the kitchen.
@tags=paraguas

[LINE]
Speakeryoung: Puedo salir.
= I can go out.

[LINE]
Speakeradult_female: Sí. Fuera también llueve.
= Yes. It is raining outside too.

[MULTIPLE_CHOICE]
> What does Rosa help Nico do?
@tags=grifo
+ Close the tap.
- Open the window.
- Buy a new umbrella.

[MATCH]
- llover <> to rain
- paraguas <> umbrella
- cocina <> kitchen
- grifo <> tap
- salir <> to go out
