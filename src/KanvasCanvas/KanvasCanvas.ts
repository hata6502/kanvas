import Color from "color";
import colorDiff from "color-diff";
import { brushes } from "../brushes";
import type { BrushType } from "../brushes";
import { fonts } from "../fonts";
import type { FontType } from "../fonts";
import { palettes } from "../palettes";
import { ToneType, tonePeriod, tones } from "../tones";
import { KanvasPointerListener } from "./KanvasPointerListener";
import type {
  KanvasPointerDownEvent,
  KanvasPointerMoveEvent,
  KanvasPointerUpEvent,
  KanvasPosition,
} from "./KanvasPointerListener";

const historyMaxLength = 30;

declare global {
  interface HTMLElementEventMap {
    kanvasHistoryChange: KanvasHistoryChangeEvent;
  }
}

type KanvasHistoryChangeEvent = CustomEvent<{
  history: string[];
  historyIndex: number;
}>;

export type KanvasCanvasMode = "shape" | "text";

const ditheringRate = 0.5;
const ditheringPattern = [
  {
    deltaX: 1,
    deltaY: 0,
    rate: (7 / 16) * ditheringRate,
  },
  {
    deltaX: -1,
    deltaY: 1,
    rate: (3 / 16) * ditheringRate,
  },
  {
    deltaX: 0,
    deltaY: 1,
    rate: (5 / 16) * ditheringRate,
  },
  {
    deltaX: 1,
    deltaY: 1,
    rate: (1 / 16) * ditheringRate,
  },
];

const colors = Object.values(palettes).flat();
const tonePeriodRange = [...Array(tonePeriod).keys()];

const patternImageDataCache = Object.fromEntries(
  Object.keys(tones).map((toneType) => {
    return [
      toneType,
      Object.fromEntries(
        colors.map((backgroundColor) => {
          return [
            backgroundColor,
            Object.fromEntries(
              colors.map((foregroundColor) => {
                return [
                  foregroundColor,
                  tonePeriodRange.map((_offsetY) => {
                    return tonePeriodRange.map((_offsetX) => {
                      return undefined as ImageData | undefined;
                    });
                  }),
                ];
              })
            ),
          ];
        })
      ),
    ];
  })
);

interface Pattern {
  toneType: ToneType;
  backgroundColor: string;
  foregroundColor: string;
  offsetY: number;
  offsetX: number;
}

const getPatternImageData = ({
  toneType,
  backgroundColor,
  foregroundColor,
  offsetY,
  offsetX,
}: Pattern) => {
  const cachedPatternImageData =
    patternImageDataCache[toneType][backgroundColor][foregroundColor][offsetY][
      offsetX
    ];

  if (cachedPatternImageData) {
    return cachedPatternImageData;
  }

  const tone = tones[toneType];
  const data: number[] = [];

  tonePeriodRange.forEach((y) => {
    tonePeriodRange.forEach((x) => {
      const isForeground =
        tone.bitmap[(y + offsetY) % tonePeriod][(x + offsetX) % tonePeriod];

      const color = isForeground ? foregroundColor : backgroundColor;

      data.push(...Color(color).rgb().array(), 255);
    });
  });

  const patternImageData = new ImageData(
    new Uint8ClampedArray(data),
    tonePeriod,
    tonePeriod
  );

  patternImageDataCache[toneType][backgroundColor][foregroundColor][offsetY][
    offsetX
  ] = patternImageData;

  return patternImageData;
};

const colorDiffCache: Record<string, number> = {};

const getBestPattern = ({
  data,
  patterns,
}: {
  data: Uint8ClampedArray;
  patterns: Pattern[];
}) => {
  let bestPattern = patterns[0];
  let bestPatternDistance = Infinity;

  patterns.forEach((pattern) => {
    let distance = 0;

    for (let dataIndex = 0; dataIndex < data.length; dataIndex += 4) {
      // Out of canvas area.
      if (data[dataIndex + 3] !== 255) {
        continue;
      }

      const patternImageData = getPatternImageData(pattern);

      const colorDiffKey = [
        data[dataIndex + 0],
        data[dataIndex + 1],
        data[dataIndex + 2],
        patternImageData.data[dataIndex + 0],
        patternImageData.data[dataIndex + 1],
        patternImageData.data[dataIndex + 2],
      ].join("-");

      const diff =
        colorDiffKey in colorDiffCache
          ? colorDiffCache[colorDiffKey]
          : colorDiff.diff(
              colorDiff.rgb_to_lab({
                R: data[dataIndex + 0],
                G: data[dataIndex + 1],
                B: data[dataIndex + 2],
              }),
              colorDiff.rgb_to_lab({
                R: patternImageData.data[dataIndex + 0],
                G: patternImageData.data[dataIndex + 1],
                B: patternImageData.data[dataIndex + 2],
              })
            );

      colorDiffCache[colorDiffKey] = diff;
      distance += diff;
    }

    if (distance < bestPatternDistance) {
      bestPattern = pattern;
      bestPatternDistance = distance;
    }
  });

  return bestPattern;
};

class KanvasCanvas extends HTMLElement {
  private brushType: BrushType;
  private canvas?: HTMLCanvasElement;
  private color: string;
  private context?: CanvasRenderingContext2D;
  private fontType: FontType;
  private history: string[];
  private historyIndex: number;
  private mode: KanvasCanvasMode;
  private prevPosition: KanvasPosition;
  private text;
  private textPreviewRect?: HTMLDivElement;
  private toneType: ToneType;
  private transactionMode?: KanvasCanvasMode;
  private actualZoom: number;
  private displayingZoom: number;

  constructor() {
    super();

    this.brushType = "small";
    this.color = "#000000";
    this.fontType = "sans-serif";
    this.history = [];
    this.historyIndex = -1;
    this.mode = "shape";
    this.prevPosition = { x: 0, y: 0 };
    this.text = "";
    this.toneType = "fill";
    this.actualZoom = 0;
    this.displayingZoom = 0;
  }

  connectedCallback(): void {
    this.innerHTML = `
      <style>
        .kanvas-canvas-container {
          display: inline-block;
          position: relative;
          overflow: hidden;
        }

        .kanvas-canvas-container * {
          touch-action: pinch-zoom;
          -moz-user-select: none;
          -webkit-user-select: none;
          -ms-user-select: none;
          user-select: none;
        }

        .kanvas-canvas-container .canvas {
          border: 1px solid #d3d3d3;
        }

        .kanvas-canvas-container .text-preview-rect {
          position: absolute;
          transform: translateY(-80%);
          white-space: nowrap;
        }
      </style>

      <div class="kanvas-canvas-container">
        <canvas class="canvas"></canvas>
        <div class="text-preview-rect"></div>
      </div>

      <kanvas-pointer-listener class="pointer-listener"></kanvas-pointer-listener>
    `;

    const canvas = this.querySelector(".canvas");
    const pointerListener = this.querySelector(".pointer-listener");
    const textPreviewRect = this.querySelector(".text-preview-rect");

    if (
      !(canvas instanceof HTMLCanvasElement) ||
      !(pointerListener instanceof KanvasPointerListener) ||
      !(textPreviewRect instanceof HTMLDivElement)
    ) {
      throw new Error("Canvas is not a 2D context");
    }

    this.canvas = canvas;
    this.textPreviewRect = textPreviewRect;

    this.addEventListener("contextmenu", this.handleContextmenu);

    pointerListener.addEventListener(
      "kanvasPointerDown",
      this.handlePointerDown
    );

    pointerListener.addEventListener(
      "kanvasPointerMove",
      this.handlePointerMove
    );

    pointerListener.addEventListener("kanvasPointerUp", this.handlePointerUp);
    pointerListener.addEventListener(
      "kanvasPointerCancel",
      this.handlePointerCancel
    );

    const context = this.canvas.getContext("2d");

    if (!context) {
      throw new Error("Canvas is not a 2D context");
    }

    this.context = context;
  }

  setBrushType({ brushType }: { brushType: BrushType }): void {
    this.brushType = brushType;
  }

  setColor({ color }: { color: string }): void {
    this.color = color;
  }

  setFontType({ fontType }: { fontType: FontType }): void {
    this.fontType = fontType;
  }

  setMode({ mode }: { mode: KanvasCanvasMode }): void {
    this.mode = mode;
  }

  setText({ text }: { text: string }): void {
    this.text = text;
  }

  setToneType({ toneType }: { toneType: ToneType }): void {
    this.toneType = toneType;
  }

  async load({
    src,
    applysMibaeFilter,
    pushesImageToHistory,
  }: {
    src: string;
    applysMibaeFilter: boolean;
    pushesImageToHistory: boolean;
  }): Promise<void> {
    const kanvasDialogRootElement = document.querySelector(
      ".kanvas-dialog-root"
    );

    if (!this.canvas || !this.context || !kanvasDialogRootElement) {
      throw new Error("Canvas is not a 2D context");
    }

    const imageElement = await new Promise<HTMLImageElement>(
      (resolve, reject) => {
        const imageElement = new Image();

        imageElement.addEventListener("error", (event) => reject(event));
        imageElement.addEventListener("load", () => resolve(imageElement));
        imageElement.src = src;
      }
    );

    const density = Math.sqrt(
      (320 * 180) / (imageElement.naturalWidth * imageElement.naturalHeight)
    );

    const imageHeight = Math.round(imageElement.naturalHeight * density);
    const imageWidth = Math.round(imageElement.naturalWidth * density);

    const heightZoom =
      (kanvasDialogRootElement.clientHeight - 112) / imageHeight;
    const widthZoom =
      (Math.min(kanvasDialogRootElement.clientWidth, 1280) - 64) / imageWidth;

    this.displayingZoom = Math.min(heightZoom, widthZoom);
    this.canvas.style.height = `${imageHeight * this.displayingZoom}px`;
    this.canvas.style.width = `${imageWidth * this.displayingZoom}px`;

    // For retina display.
    this.actualZoom = Math.ceil(this.displayingZoom * 2);
    this.canvas.height = imageHeight * this.actualZoom;
    this.canvas.width = imageWidth * this.actualZoom;

    this.context.imageSmoothingEnabled = false;

    this.context.drawImage(
      imageElement,
      0,
      0,
      this.canvas.width,
      this.canvas.height
    );

    if (applysMibaeFilter) {
      await this.applyMibaeFilter();
    }

    if (pushesImageToHistory) {
      this.pushImageToHistory();
    }
  }

  redo(): void {
    if (this.historyIndex >= this.history.length - 1) {
      return;
    }

    this.historyIndex++;
    this.putImageFromHistory();
    this.dispatchChangeHistoryEvent();
  }

  toBlob(callback: BlobCallback, type?: string, quality?: unknown): void {
    if (!this.canvas) {
      throw new Error("Canvas is not a 2D context");
    }

    return this.canvas.toBlob(callback, type, quality);
  }

  toDataURL(type?: string, quality?: unknown): string {
    if (!this.canvas) {
      throw new Error("Canvas is not a 2D context");
    }

    return this.canvas.toDataURL(type, quality);
  }

  undo(): void {
    if (this.historyIndex < 1) {
      return;
    }

    this.historyIndex--;
    this.putImageFromHistory();
    this.dispatchChangeHistoryEvent();
  }

  private getCanvasPosition(clientPosition: KanvasPosition): KanvasPosition {
    if (!this.canvas) {
      throw new Error("Canvas is not a 2D context");
    }

    const domRect = this.canvas.getBoundingClientRect();
    const pixelX = clientPosition.x - (domRect.left + 1);
    const pixelY = clientPosition.y - (domRect.top + 1);

    return {
      x: Math.round(pixelX / this.displayingZoom),
      y: Math.round(pixelY / this.displayingZoom),
    };
  }

  private async applyMibaeFilter() {
    if (!this.canvas) {
      throw new Error("Canvas is not a 2D context");
    }

    const shrinkedCanvasElement = document.createElement("canvas");

    shrinkedCanvasElement.width = this.canvas.width / this.actualZoom;
    shrinkedCanvasElement.height = this.canvas.height / this.actualZoom;

    const shrinkedContext = shrinkedCanvasElement.getContext("2d");

    if (!shrinkedContext) {
      throw new Error("Canvas is not a 2D context");
    }

    shrinkedContext.imageSmoothingEnabled = false;

    shrinkedContext.drawImage(
      this.canvas,
      0,
      0,
      shrinkedCanvasElement.width,
      shrinkedCanvasElement.height
    );

    for (let y = 0; y < shrinkedCanvasElement.height; y++) {
      [...Array(shrinkedCanvasElement.width).keys()].forEach((x) => {
        if (!this.context) {
          throw new Error("Canvas is not a 2D context");
        }

        const beginX = x - tonePeriod / 2;
        const beginY = y - tonePeriod / 2;

        const windowImageData = shrinkedContext.getImageData(
          beginX,
          beginY,
          tonePeriod,
          tonePeriod
        );

        const normalizedData = Uint8ClampedArray.from(windowImageData.data);
        const lightnesses = [];

        for (
          let dataIndex = 0;
          dataIndex < normalizedData.length;
          dataIndex += 4
        ) {
          // Out of canvas area.
          if (normalizedData[dataIndex + 3] !== 255) {
            continue;
          }

          const average = Color({
            r: normalizedData[dataIndex + 0],
            g: normalizedData[dataIndex + 1],
            b: normalizedData[dataIndex + 2],
          })
            .grayscale()
            .red();

          normalizedData[dataIndex + 0] =
            normalizedData[dataIndex + 1] =
            normalizedData[dataIndex + 2] =
              average;

          lightnesses.push(average);
        }

        const maxLightness = Math.max(...lightnesses);
        const minLightness = Math.min(...lightnesses);

        for (
          let dataIndex = 0;
          dataIndex < normalizedData.length;
          dataIndex += 4
        ) {
          // Out of canvas area.
          if (normalizedData[dataIndex + 3] !== 255) {
            continue;
          }

          normalizedData[dataIndex + 0] =
            normalizedData[dataIndex + 1] =
            normalizedData[dataIndex + 2] =
              ((normalizedData[dataIndex + 0] - minLightness) * 255) /
              (maxLightness - minLightness);
        }

        const offsetX = Math.abs(beginX % tonePeriod);
        const offsetY = Math.abs(beginY % tonePeriod);

        const { toneType } = getBestPattern({
          data: normalizedData,
          patterns: Object.keys(tones).map((toneType) => ({
            toneType: toneType as ToneType,
            backgroundColor: palettes.light[0],
            foregroundColor: palettes.dark[0],
            offsetY,
            offsetX,
          })),
        });
        const tone = tones[toneType];

        const { backgroundColor } = getBestPattern({
          data: windowImageData.data,
          patterns: colors.map((backgroundColor) => ({
            toneType,
            backgroundColor,
            foregroundColor: palettes.dark[0],
            offsetY,
            offsetX,
          })),
        });

        const { foregroundColor } = getBestPattern({
          data: windowImageData.data,
          patterns: colors.map((foregroundColor) => ({
            toneType,
            backgroundColor,
            foregroundColor,
            offsetY,
            offsetX,
          })),
        });

        const isForeground = tone.bitmap[y % tonePeriod][x % tonePeriod];

        this.context.fillStyle = isForeground
          ? foregroundColor
          : backgroundColor;

        this.context.fillRect(
          x * this.actualZoom,
          y * this.actualZoom,
          this.actualZoom,
          this.actualZoom
        );

        // Floyd–Steinberg dithering
        const [originalR, originalG, originalB] = shrinkedContext.getImageData(
          x,
          y,
          1,
          1
        ).data;

        const [putR, putG, putB] = this.context.getImageData(
          x * this.actualZoom,
          y * this.actualZoom,
          1,
          1
        ).data;

        ditheringPattern.forEach(({ deltaX, deltaY, rate }) => {
          const NeighborhoodImageData = shrinkedContext.getImageData(
            x + deltaX,
            y + deltaY,
            1,
            1
          );

          NeighborhoodImageData.data[0] += (originalR - putR) * rate;
          NeighborhoodImageData.data[1] += (originalG - putG) * rate;
          NeighborhoodImageData.data[2] += (originalB - putB) * rate;

          shrinkedContext.putImageData(
            NeighborhoodImageData,
            x + deltaX,
            y + deltaY
          );
        });
      });

      await new Promise((resolve) => setTimeout(resolve));
    }
  }

  private dispatchChangeHistoryEvent() {
    const event: KanvasHistoryChangeEvent = new CustomEvent(
      "kanvasHistoryChange",
      {
        bubbles: true,
        composed: true,
        detail: {
          history: this.history,
          historyIndex: this.historyIndex,
        },
      }
    );

    this.dispatchEvent(event);
  }

  private displayTextPreviewRect(position: KanvasPosition) {
    if (!this.context || !this.textPreviewRect) {
      throw new Error("Canvas is not a 2D context");
    }

    const font = `${
      brushes[this.brushType].font.size * this.displayingZoom
    }px ${fonts[this.fontType]}`;

    this.context.font = font;

    this.textPreviewRect.style.left = `${
      position.x * this.displayingZoom + 1
    }px`;

    this.textPreviewRect.style.top = `${
      position.y * this.displayingZoom + 1
    }px`;

    this.textPreviewRect.style.color = this.color;
    this.textPreviewRect.style.font = font;
    this.textPreviewRect.textContent = this.text;
  }

  private drawLine({ from, to }: { from: KanvasPosition; to: KanvasPosition }) {
    const stepLength = Math.round(
      Math.sqrt(Math.pow(to.x - from.x, 2.0) + Math.pow(to.y - from.y, 2.0))
    );

    [...Array(stepLength).keys()].forEach((step) => {
      const distance = step / stepLength;

      this.drawPoint({
        x: Math.round(from.x + (to.x - from.x) * distance),
        y: Math.round(from.y + (to.y - from.y) * distance),
      });
    });
  }

  private drawPoint(position: KanvasPosition) {
    if (!this.context) {
      throw new Error("Canvas is not a 2D context");
    }

    const brush = brushes[this.brushType];
    const beginX = position.x - (brush.bitmap[0].length - 1) / 2;
    const beginY = position.y - (brush.bitmap.length - 1) / 2;
    const tone = tones[this.toneType];

    this.context.fillStyle = this.color;

    for (let y = beginY; y < beginY + brush.bitmap.length; y++) {
      for (let x = beginX; x < beginX + brush.bitmap[0].length; x++) {
        if (
          brush.bitmap[Math.abs(y - beginY)][Math.abs(x - beginX)] === 0 ||
          tone.bitmap[Math.abs(y % tonePeriod)][Math.abs(x % tonePeriod)] === 0
        ) {
          continue;
        }

        this.context.fillRect(
          x * this.actualZoom,
          y * this.actualZoom,
          this.actualZoom,
          this.actualZoom
        );
      }
    }
  }

  private pushImageToHistory() {
    if (!this.canvas) {
      throw new Error("Canvas is not a 2D context");
    }

    const dataURL = this.canvas.toDataURL();

    if (this.historyIndex >= 0 && this.history[this.historyIndex] === dataURL) {
      return;
    }

    this.history = [
      ...this.history.slice(
        Math.max(this.historyIndex - historyMaxLength, 0),
        this.historyIndex + 1
      ),
      dataURL,
    ];

    this.historyIndex = this.history.length - 1;
    this.dispatchChangeHistoryEvent();
  }

  private putImageFromHistory() {
    void this.load({
      src: this.history[this.historyIndex],
      applysMibaeFilter: false,
      pushesImageToHistory: false,
    });
  }

  private handleContextmenu = (event: Event) => event.preventDefault();

  private handlePointerDown = (event: KanvasPointerDownEvent) => {
    if (this.transactionMode) {
      return;
    }

    const position = this.getCanvasPosition(event.detail);

    switch (this.mode) {
      case "shape": {
        this.transactionMode = "shape";
        this.drawPoint(position);

        break;
      }

      case "text": {
        this.transactionMode = "text";
        this.displayTextPreviewRect(position);

        break;
      }

      default: {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const exhaustiveCheck: never = this.mode;

        throw new Error("Unknown mode");
      }
    }

    this.prevPosition = position;
  };

  private handlePointerMove = (event: KanvasPointerMoveEvent) => {
    if (!this.transactionMode) {
      return;
    }

    const position = this.getCanvasPosition(event.detail);

    switch (this.transactionMode) {
      case "shape": {
        this.drawLine({
          from: this.prevPosition,
          to: position,
        });

        break;
      }

      case "text": {
        this.displayTextPreviewRect(position);

        break;
      }

      default: {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const exhaustiveCheck: never = this.transactionMode;

        throw new Error("Unknown mode");
      }
    }

    this.prevPosition = position;
  };

  private handlePointerUp = (event: KanvasPointerUpEvent) => {
    if (!this.transactionMode) {
      return;
    }

    const canvasPosition = this.getCanvasPosition(event.detail);

    switch (this.transactionMode) {
      case "shape": {
        this.drawLine({
          from: this.prevPosition,
          to: canvasPosition,
        });

        break;
      }

      case "text": {
        if (!this.context || !this.textPreviewRect) {
          throw new Error("Canvas is not a 2D context");
        }

        this.context.fillStyle = this.color;

        this.context.font = `${
          brushes[this.brushType].font.size * this.actualZoom
        }px ${fonts[this.fontType]}`;

        this.context.fillText(
          this.text,
          canvasPosition.x * this.actualZoom,
          canvasPosition.y * this.actualZoom
        );

        this.textPreviewRect.textContent = "";

        break;
      }

      default: {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const exhaustiveCheck: never = this.transactionMode;

        throw new Error("Unknown mode");
      }
    }

    this.pushImageToHistory();
    this.transactionMode = undefined;
  };

  private handlePointerCancel = () => {
    if (!this.transactionMode) {
      return;
    }

    if (!this.textPreviewRect) {
      throw new Error("Text preview rect is not defined");
    }

    switch (this.transactionMode) {
      case "shape": {
        this.putImageFromHistory();

        break;
      }

      case "text": {
        this.textPreviewRect.textContent = "";

        break;
      }

      default: {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const exhaustiveCheck: never = this.transactionMode;

        throw new Error("Unknown mode");
      }
    }

    this.transactionMode = undefined;
  };
}

customElements.define("kanvas-canvas", KanvasCanvas);

export { KanvasCanvas };
export type { KanvasHistoryChangeEvent };
