// edge_raster.hpp -- the film edge's drawing layer off Apple (RFC-031/032).
//
// overscan.cpp lays out the edge print and the date in film millimetres and
// on macOS draws them with CoreGraphics and CoreText into an 8-bit coverage
// bitmap, then softens it with vImage. This is the same three services for
// the Windows/Linux engine, behind the smallest interface overscan.cpp needs:
//
//   Canvas     an antialiased coverage bitmap. Paths are filled by exact
//              area coverage under the non-zero rule, and each fill is
//              composited "source over" with its own grey, as CG does.
//   text_*     glyph outlines and advances from the bundled fonts
//              (resources/fonts/README.txt names each substitute), through
//              stb_truetype, laid out the way the CoreText call sites in
//              overscan.cpp ask for.
//   blur       a separable convolution with edges extended (vImage's
//              kvImageEdgeExtend), threaded over lines.
//
// Coordinates handed to Canvas are bitmap pixels, y down; the caller owns
// the film -> canvas mapping.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace spk::edge {

struct Point { double x, y; };

// A 2-D affine map, CoreGraphics' convention: x' = a x + c y + tx,
// y' = b x + d y + ty.
struct Affine {
    double a = 1, b = 0, c = 0, d = 1, tx = 0, ty = 0;
    Point apply(Point p) const { return {a * p.x + c * p.y + tx, b * p.x + d * p.y + ty}; }
    // this * m: m applied first, then this (CGAffineTransformConcat(m, this)).
    Affine then_after(const Affine& m) const {
        return {a * m.a + c * m.b, b * m.a + d * m.b, a * m.c + c * m.d, b * m.c + d * m.d,
                a * m.tx + c * m.ty + tx, b * m.tx + d * m.ty + ty};
    }
    static Affine translate(double x, double y) { return {1, 0, 0, 1, x, y}; }
    static Affine scale(double sx, double sy) { return {sx, 0, 0, sy, 0, 0}; }
    static Affine rotate(double radians);
};

// One path: closed contours, already in bitmap pixels.
using Contour = std::vector<Point>;

class Canvas {
public:
    Canvas(int w, int h);
    // Fill the contours (non-zero winding) with grey `gain` in [0, 1].
    void fill(const std::vector<Contour>& path, double gain);
    // The bitmap as CoreGraphics' 8-bit grey would hold it, read back to
    // float in [0, 1].
    void coverage(std::vector<float>& out) const;

private:
    int w_, h_;
    std::vector<float> grey_;   // composited value per pixel
    std::vector<float> acc_;    // scratch: signed area per cell, (w + 2) per row
    void line(Point p0, Point p1);
};

// A circle as a polygon in the caller's units, fine enough at `px_per_unit`
// that its edge stays within 0.01 px of the true circle's.
Contour circle(Point centre, double radius, double px_per_unit);

// Where the bundled fonts live; set once by spk_engine_create.
void set_font_directory(const std::string& dir);

// The typographic width of `text` in `font` (a macOS PostScript name; see
// fonts/README.txt) at `size` per em, with `tracking` added after every
// character -- what CTLineGetTypographicBounds returns for overscan.cpp's
// attributed string (an explicit kCTKernAttributeName turns the font's own
// pair kerning off). False if the font cannot be loaded.
bool text_width(const char* font, double size, const std::string& text, double tracking, double& width);

// The glyph outlines of that line in its own text space (x along the
// baseline from the origin, y *up*), each glyph's shape scaled by
// `glyph_xscale` about its own origin while the advances are not -- the
// CoreText text matrix's effect -- then mapped through `to_px`. Curves are
// flattened finely enough for the target's pixel size.
bool text_outline(const char* font, double size, const std::string& text, double tracking,
                  double glyph_xscale, const Affine& to_px, std::vector<Contour>& out);

// Separable convolution of a w x h plane with `kernel` (odd length) along x
// then y, edges extended.
void blur(std::vector<float>& plane, int w, int h, const std::vector<float>& kernel);

}  // namespace spk::edge
