// Windows nativeImage does not decode SVG data URLs. Use a real 32px bitmap
// for a crisp, visible calendar icon on both light and dark taskbars.
module.exports = function createTrayIcon(nativeImage) {
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  const rect = (left, top, width, height, [r, g, b]) => {
    for (let y = top; y < top + height; y++) {
      for (let x = left; x < left + width; x++) {
        const offset = (y * size + x) * 4;
        // Electron's native bitmap uses BGRA byte order on Windows.
        pixels[offset] = b;
        pixels[offset + 1] = g;
        pixels[offset + 2] = r;
        pixels[offset + 3] = 255;
      }
    }
  };
  const purple = [91, 108, 255];
  const white = [255, 255, 255];
  rect(2, 4, 28, 26, purple);
  rect(5, 12, 22, 15, white);
  rect(8, 2, 3, 7, white);
  rect(21, 2, 3, 7, white);
  rect(9, 18, 4, 4, purple);
  rect(12, 21, 4, 4, purple);
  rect(15, 18, 4, 4, purple);
  rect(18, 15, 4, 4, purple);
  const icon = nativeImage.createFromBitmap(pixels, { width: size, height: size });
  if (icon.isEmpty()) throw new Error('无法创建系统托盘图标');
  return icon;
};
