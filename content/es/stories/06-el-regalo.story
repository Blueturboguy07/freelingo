[DATA]
id=06-el-regalo
language=es
unit=30
fromLanguageName=The present
author=Codex P6 author
narrator_register=tu
cover=stories/06-el-regalo/cover.png

[HEADER]
> El regalo

[LINE]
Speakeradult_female: Hoy es mi cumpleaños.
= Today is my birthday.

[LINE]
Speakeradult_male: Tenemos un regalo para ti.
= We have a present for you.

[LINE]
Speakeryoung: Está en una caja grande.
= It is in a big box.

[LINE]
Speakeradult_female: ¿Un libro?
= A book?

[LINE]
Speakeradult_male: No.
= No.

[MULTIPLE_CHOICE]
> What is inside the smallest box?
@tags=llave
+ A key.
- A bicycle.
- A lamp.

[LINE]
Speakeradult_female: ¿Una lámpara?
= A lamp?

[LINE]
Speakeryoung: No. El regalo es pequeño.
= No. The present is small.

[LINE]
Speakeradult_female: Entonces la caja es demasiado grande.
= Then the box is too big.

[CONTINUATION]
> Select the missing word or phrase
Speakeryoung: El regalo es [pequeño].
= The present is small.
@tags=pequeño
+ pequeño
- viejo
- redondo

[LINE]
Speakeradult_male: Hay otra caja dentro.
= There is another box inside.

[LINE]
Speakeradult_female: ¿Y dentro de esa caja?
= And inside that box?

[LINE]
Speakeryoung: Hay otra caja.
= There is another box.

[ARRANGE]
> Tap what you hear
Speakeradult_male: [(Hay) (otra) (caja) (dentro)].
= There is another box inside.
@tags=caja

[LINE]
Speakeradult_female: ¿Cuántas cajas tengo que abrir?
= How many boxes do I have to open?

[LINE]
Speakeradult_male: Tres.
= Three.

[LINE]
Speakeradult_female: ¡Aquí está el regalo!
= Here is the present!

[POINT_TO_PHRASE]
> Select the meaning for “present”
Speakeryoung: El (+regalo) está en una (caja).
= The present is in a box.
@tags=regalo

[LINE]
Speakeryoung: Es una llave.
= It is a key.

[LINE]
Speakeradult_male: Tu bicicleta nueva está en el jardín.
= Your new bicycle is in the garden.

[MULTIPLE_CHOICE]
> Where is Rosa’s new bicycle?
@tags=bicicleta
+ In the garden.
- Inside the box.
- At the shop.

[MATCH]
- regalo <> present
- caja <> box
- pequeño <> small
- llave <> key
- bicicleta <> bicycle
