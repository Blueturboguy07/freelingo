[DATA]
id=02-la-llave
language=es
unit=10
fromLanguageName=The key
author=Codex P6 author
narrator_register=tu
cover=stories/02-la-llave/cover.png

[HEADER]
> La llave

[LINE]
Speakeradult_female: ¿Dónde está mi llave?
= Where is my key?

[LINE]
Speakeradult_male: ¿En tu bolso?
= In your bag?

[LINE]
Speakeradult_female: No. Mi bolso está vacío.
= No. My bag is empty.

[LINE]
Speakeradult_male: Hay una cosa debajo de la mesa.
= There is something under the table.

[LINE]
Speakeradult_female: Es un lápiz.
= It is a pencil.

[MULTIPLE_CHOICE]
> What is under the table?
@tags=lápiz
+ A pencil.
- A key.
- A phone.

[LINE]
Speakeradult_male: ¿Y debajo de la silla?
= And under the chair?

[LINE]
Speakeradult_female: Es un bolígrafo.
= It is a pen.

[LINE]
Speakeradult_male: Tu libro está encima de la mesa.
= Your book is on the table.

[CONTINUATION]
> Select the missing word or phrase
Speakeradult_female: Mi bolso está [vacío].
= My bag is empty.
@tags=bolso
+ vacío
- caliente
- caro

[LINE]
Speakeradult_female: Sí. La llave no está allí.
= Yes. The key is not there.

[LINE]
Speakeradult_male: ¿Tu bolso está abierto?
= Is your bag open?

[LINE]
Speakeradult_female: No. Está cerrado.
= No. It is closed.

[ARRANGE]
> Tap what you hear
Speakeradult_male: [(Tu) (llave) (está) (dentro)].
= Your key is inside.
@tags=llave

[LINE]
Speakeradult_male: ¿Puedes abrir tu bolso?
= Can you open your bag?

[LINE]
Speakeradult_female: Sí.
= Yes.

[LINE]
Speakeradult_male: Tu llave está dentro.
= Your key is inside.

[POINT_TO_PHRASE]
> Select the meaning for “empty”
Speakeradult_female: Mi (bolso) está (+vacío).
= My bag is empty.
@tags=bolso

[LINE]
Speakeradult_female: ¡Mi bolso no está vacío!
= My bag is not empty!

[LINE]
Speakeradult_male: ¡Y tu llave no está lejos!
= And your key is not far away!

[MULTIPLE_CHOICE]
> Where is the key?
@tags=llave
+ Inside the bag.
- Under the chair.
- On the table.

[MATCH]
- llave <> key
- bolso <> bag
- mesa <> table
- lápiz <> pencil
- dentro <> inside
