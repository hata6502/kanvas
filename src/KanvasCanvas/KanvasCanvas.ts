import "@material/mwc-dialog";
import blankPNG from "../blank.png";
import { brushes } from "../brushes";
import type { BrushType } from "../brushes";
import { dialogMaxWidth } from "../KanvasDialog";
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

type Mode = "shape" | "text";

class KanvasCanvas extends HTMLElement {
  private brushType: BrushType;
  private canvas;
  private color: string;
  private height: number;
  private history: string[];
  private historyIndex: number;
  private mode: Mode;
  private prevCanvasPosition: KanvasPosition;
  private text;
  private width: number;
  private zoom: number;

  constructor() {
    super();

    this.brushType = "light";
    this.color = "#000000";
    this.height = 0;
    this.history = [];
    this.historyIndex = -1;
    this.mode = "shape";
    this.text = "";
    this.prevCanvasPosition = { x: 0, y: 0 };
    this.width = 0;
    this.zoom = 0;

    const shadow = this.attachShadow({ mode: "open" });

    shadow.innerHTML = `
      <canvas
        id="canvas"
        style="border: 1px solid #d3d3d3;"
      ></canvas>

      <kanvas-pointer-listener id="pointer-listener"></kanvas-pointer-listener>
    `;

    const canvas = shadow.querySelector("#canvas");
    const pointerListener = shadow.querySelector("#pointer-listener");

    if (
      !(canvas instanceof HTMLCanvasElement) ||
      !(pointerListener instanceof KanvasPointerListener)
    ) {
      throw new Error("Could not find canvas or pointer listener");
    }

    this.canvas = canvas;

    pointerListener.addEventListener(
      "kanvasPointerDown",
      this.handlePointerDown
    );

    pointerListener.addEventListener(
      "kanvasPointerMove",
      this.handlePointerMove
    );

    pointerListener.addEventListener("kanvasPointerUp", this.handlePointerUp);

    void this.load({ src: blankPNG });
  }

  setBrushType({ brushType }: { brushType: BrushType }): void {
    this.brushType = brushType;
  }

  setColor({ color }: { color: string }): void {
    this.color = color;
  }

  setMode({ mode }: { mode: Mode }): void {
    this.mode = mode;
  }

  setText({ text }: { text: string }): void {
    this.text = text;
  }

  clear(): void {
    const context = this.canvas.getContext("2d");

    if (!context) {
      throw new Error("Canvas is not a 2D context");
    }

    context.fillStyle = this.color;
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.pushHistory();
  }

  async load({ src }: { src: string }): Promise<void> {
    const context = this.canvas.getContext("2d");

    if (!context) {
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
      (320 * 180) / imageElement.naturalWidth / imageElement.naturalHeight
    );

    this.height = Math.round(imageElement.naturalHeight * density);
    this.width = Math.round(imageElement.naturalWidth * density);

    const heightZoom = (window.innerHeight - 144) / this.height;

    const widthZoom =
      (Math.min(window.innerWidth, dialogMaxWidth) - 96) / this.width;

    this.zoom = Math.min(heightZoom, widthZoom);
    this.canvas.height = this.height * this.zoom;
    this.canvas.width = this.width * this.zoom;

    context.drawImage(
      imageElement,
      0,
      0,
      this.canvas.width,
      this.canvas.height
    );
  }

  redo(): void {
    if (this.historyIndex >= this.history.length - 1) {
      return;
    }

    this.historyIndex++;
    this.putHistory();
    this.dispatchChangeHistoryEvent();
  }

  toBlob(callback: BlobCallback, type?: string, quality?: unknown): void {
    return this.canvas.toBlob(callback, type, quality);
  }

  toDataURL(type?: string, quality?: unknown): string {
    return this.canvas.toDataURL(type, quality);
  }

  undo(): void {
    if (this.historyIndex < 1) {
      return;
    }

    this.historyIndex--;
    this.putHistory();
    this.dispatchChangeHistoryEvent();
  }

  private getCanvasPosition(clientPosition: KanvasPosition): KanvasPosition {
    const domRect = this.canvas.getBoundingClientRect();
    const pixelX = clientPosition.x - (domRect.left + 1);
    const pixelY = clientPosition.y - (domRect.top + 1);

    return {
      x: Math.round(pixelX / this.zoom),
      y: Math.round(pixelY / this.zoom),
    };
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

  private drawLine({ from, to }: { from: KanvasPosition; to: KanvasPosition }) {
    const stepLength = Math.round(
      Math.sqrt(Math.pow(to.x - from.x, 2.0) + Math.pow(to.y - from.y, 2.0))
    );

    [...Array(stepLength).keys()].forEach((step) => {
      const distance = step / stepLength;

      this.drawPoint({
        x: from.x + Math.round((to.x - from.x) * distance),
        y: from.y + Math.round((to.y - from.y) * distance),
      });
    });
  }

  private drawPoint(position: KanvasPosition) {
    const context = this.canvas.getContext("2d");

    if (!context) {
      throw new Error("Canvas is not a 2D context");
    }

    const brush = brushes[this.brushType];

    context.fillStyle = this.color;

    switch (this.mode) {
      case "shape": {
        const beginX = position.x - (brush.bitmap[0].length - 1) / 2;
        const beginY = position.y - (brush.bitmap.length - 1) / 2;

        for (let y = beginY; y < beginY + brush.bitmap.length; y++) {
          for (let x = beginX; x < beginX + brush.bitmap[0].length; x++) {
            if (brush.bitmap[y - beginY][x - beginX] === 0) {
              continue;
            }

            context.fillRect(
              x * this.zoom,
              y * this.zoom,
              this.zoom,
              this.zoom
            );
          }
        }

        break;
      }

      case "text": {
        if (
          position.x < 0 ||
          position.x >= this.width ||
          position.y < 0 ||
          position.y >= this.height
        ) {
          break;
        }

        context.font = `${brush.font.size * this.zoom}px sans-serif`;

        context.fillText(
          this.text,
          position.x * this.zoom,
          position.y * this.zoom
        );

        break;
      }

      default: {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const exhaustiveCheck: never = this.mode;

        throw new Error("Unknown mode");
      }
    }
  }

  private pushHistory() {
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

  private putHistory() {
    const context = this.canvas.getContext("2d");
    const image = new Image();

    if (!context) {
      throw new Error("Canvas is not a 2D context");
    }

    image.onload = () => context.drawImage(image, 0, 0);
    image.src = this.history[this.historyIndex];
  }

  private handlePointerDown = (event: KanvasPointerDownEvent) => {
    if (this.canvas.offsetParent === null) {
      return;
    }

    const position = this.getCanvasPosition(event.detail);

    this.drawPoint(position);
    this.prevCanvasPosition = position;
  };

  private handlePointerMove = (event: KanvasPointerMoveEvent) => {
    if (this.canvas.offsetParent === null) {
      return;
    }

    switch (this.mode) {
      case "shape": {
        const canvasPosition = this.getCanvasPosition(event.detail);

        this.drawLine({
          from: this.prevCanvasPosition,
          to: canvasPosition,
        });

        this.prevCanvasPosition = canvasPosition;

        break;
      }

      case "text": {
        break;
      }

      default: {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const exhaustiveCheck: never = this.mode;

        throw new Error("Unknown mode");
      }
    }
  };

  private handlePointerUp = (event: KanvasPointerUpEvent) => {
    if (this.canvas.offsetParent === null) {
      return;
    }

    switch (this.mode) {
      case "shape": {
        const canvasPosition = this.getCanvasPosition(event.detail);

        this.drawLine({
          from: this.prevCanvasPosition,
          to: canvasPosition,
        });

        break;
      }

      case "text": {
        break;
      }

      default: {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const exhaustiveCheck: never = this.mode;

        throw new Error("Unknown mode");
      }
    }

    this.pushHistory();
  };
}

customElements.define("kanvas-canvas", KanvasCanvas);

export { KanvasCanvas };
export type { KanvasHistoryChangeEvent };