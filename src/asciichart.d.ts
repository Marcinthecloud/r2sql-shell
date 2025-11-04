declare module 'asciichart' {
  interface PlotConfig {
    height?: number;
    offset?: number;
    padding?: string;
    colors?: number[];
    min?: number;
    max?: number;
    format?: (x: number, i: number) => string;
  }

  export function plot(series: number[] | number[][], config?: PlotConfig): string;

  export const black: number;
  export const red: number;
  export const green: number;
  export const yellow: number;
  export const blue: number;
  export const magenta: number;
  export const cyan: number;
  export const lightgray: number;
  export const darkgray: number;
  export const lightred: number;
  export const lightgreen: number;
  export const lightyellow: number;
  export const lightblue: number;
  export const lightmagenta: number;
  export const lightcyan: number;
  export const white: number;
}
