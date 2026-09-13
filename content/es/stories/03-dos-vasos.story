[DATA]
id=03-dos-vasos
language=es
unit=12
fromLanguageName=Two glasses
author=Codex P6 author
narrator_register=tu
cover=stories/03-dos-vasos/cover.png

[HEADER]
> Dos vasos

[LINE]
Speakeradult_male: Quiero agua, por favor.
= I would like water, please.

[LINE]
Speakeryoung: ¿Agua fría?
= Cold water?

[LINE]
Speakeradult_male: Sí. Dos vasos.
= Yes. Two glasses.

[LINE]
Speakeryoung: ¿Dos vasos de agua?
= Two glasses of water?

[LINE]
Speakeradult_male: Sí. Mi hermana también quiere agua.
= Yes. My sister wants water too.

[MULTIPLE_CHOICE]
> What does Rosa want?
@tags=agua
+ Water without ice.
- Coffee.
- Water with ice.

[LINE]
Speakeryoung: Tu hermana quiere café.
= Your sister wants coffee.

[LINE]
Speakeradult_female: No. Quiero agua.
= No. I want water.

[LINE]
Speakeryoung: ¿Con hielo?
= With ice?

[CONTINUATION]
> Select the missing word or phrase
Speakeradult_female: Quiero agua [sin hielo].
= I want water without ice.
@tags=hielo
+ sin hielo
- con café
- con leche

[LINE]
Speakeradult_female: Sin hielo, por favor.
= Without ice, please.

[LINE]
Speakeradult_male: Yo quiero hielo.
= I want ice.

[LINE]
Speakeryoung: Un vaso con hielo. Un vaso sin hielo.
= One glass with ice. One glass without ice.

[ARRANGE]
> Tap what you hear
Speakeryoung: [(Un) (vaso) (con) (hielo)].
= One glass with ice.
@tags=vaso

[LINE]
Speakeradult_female: Gracias.
= Thank you.

[LINE]
Speakeradult_male: Mi vaso está vacío.
= My glass is empty.

[LINE]
Speakeryoung: Tiene hielo.
= It has ice.

[POINT_TO_PHRASE]
> Select the meaning for “empty”
Speakeradult_male: Mi (vaso) está (+vacío).
= My glass is empty.
@tags=vacío

[LINE]
Speakeradult_male: Quiero agua también.
= I want water too.

[LINE]
Speakeryoung: ¡Claro!
= Of course!

[MULTIPLE_CHOICE]
> What is missing from Mateo’s glass?
@tags=vaso
+ Water.
- Ice.
- The glass.

[MATCH]
- agua <> water
- vaso <> glass
- hielo <> ice
- hermana <> sister
- vacío <> empty
