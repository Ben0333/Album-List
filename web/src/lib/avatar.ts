const TARGET_SIZE = 200;

export async function readImageAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Could not read file.'));
    reader.readAsDataURL(file);
  });
}

export async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image.'));
    img.src = src;
  });
}

export async function composeAvatar(
  dataUrl: string,
  zoom: number,
  panX: number,
  panY: number
): Promise<string> {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = TARGET_SIZE;
  canvas.height = TARGET_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not supported.');

  const scale = Math.max(TARGET_SIZE / image.width, TARGET_SIZE / image.height) * Math.max(1, zoom);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  const dx = (TARGET_SIZE - drawWidth) / 2 + (panX / 100) * (drawWidth / 2);
  const dy = (TARGET_SIZE - drawHeight) / 2 + (panY / 100) * (drawHeight / 2);

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, TARGET_SIZE, TARGET_SIZE);
  ctx.drawImage(image, dx, dy, drawWidth, drawHeight);

  return canvas.toDataURL('image/jpeg', 0.85);
}
