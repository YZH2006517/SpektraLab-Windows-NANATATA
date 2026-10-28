Fonts for the film edge print and the date back off Apple (RFC-031/032).

The macOS engine draws these marks with CoreText in Helvetica Neue, Arial
Narrow and Menlo, which cannot be redistributed. The Windows/Linux engine
(src/pipeline/edge_raster.cpp) maps each name to a freely licensed font with
the same design and close metrics:

  HelveticaNeue          texgyreheros-regular.otf    TeX Gyre Heros 2.004
  HelveticaNeue-Bold     texgyreheros-bold.otf       TeX Gyre Heros 2.004
  HelveticaNeue-Medium   texgyreheros-bold.otf       (Heros has no Medium)
  ArialNarrow            texgyreheroscn-regular.otf  TeX Gyre Heros Cn 2.004
  Menlo-Bold             DejaVuSansMono-Bold.ttf     DejaVu 2.37 (Menlo is
                                                     derived from it)

TeX Gyre: GUST Font License / LPPL 1.3c (TeX-Gyre-GUST-FONT-LICENSE.txt),
from CTAN fonts/tex-gyre/opentype. DejaVu: Bitstream Vera licence with
DejaVu changes in the public domain (DejaVu-LICENSE.txt). Unmodified.

SHA-256
  6ae1a09d5a940367b7aaaa91ee8bd8a2c333bfe193e7096e23f931357d62081f  texgyreheros-regular.otf
  b170162835f4efc288886dd4231406dc47e19b614cf4416836635599d44a7d60  texgyreheros-bold.otf
  1ecf653e4245d8e95e913fa43e3cf7cc8f25e2ff03ba16df7db1a9e83a401a7a  texgyreheroscn-regular.otf
  bce60f1b4421acd9ea51ba6623d7024ecbe6817a953e3654df62a5e6bdf8f769  DejaVuSansMono-Bold.ttf
