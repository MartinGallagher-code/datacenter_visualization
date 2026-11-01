# A stand-in for Modeling_2026's 6502 model

`tools/mos6502-export` reads `full_stack/mos_6502` from a Modeling_2026
checkout. CI has none, so `tests/run.mjs` points the tool at this directory:
the same modules, classes and functions, with **made-up numbers** small enough
to work out by hand. It tests what the tool does with what the model says, and
says nothing about the 6502. The real model is in
MartinGallagher-code/Modeling_2026.
