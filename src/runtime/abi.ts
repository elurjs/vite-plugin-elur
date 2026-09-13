// ABI del código generado (C.17). Módulo mínimo: lo importan tanto
// `runtime/compiler` (lo re-exporta para el código generado) como el plugin
// en `index.ts` para validar compatibilidad en build-time sin arrastrar el
// runtime completo al import graph del plugin.

/**
 * Versión de ABI que este runtime soporta. El compilador emite
 * `__elurAbi(N)` al inicio de cada módulo compilado con su
 * `COMPILER_ABI_VERSION`; ambos deben coincidir exactamente.
 */
export const ELUR_COMPILER_ABI = 1;

/**
 * Check runtime emitido en el código generado. console.error fuerte (no
 * throw): un ABI nuevo con runtime viejo ya falla antes en el import si
 * falta algún helper — el error visible evita diagnósticos silenciosos.
 */
export function __elurAbi(v: number): void {
  if (v !== ELUR_COMPILER_ABI) {
    console.error(
      `[elur] Compiler ABI mismatch: el código generado requiere ABI ${v} ` +
        `pero @elurjs/vite-plugin-elur soporta ${ELUR_COMPILER_ABI}. ` +
        `Alinea las versiones de @elurjs/core-compiler y @elurjs/vite-plugin-elur.`,
    );
  }
}

/**
 * Check build-time: lanza si el compilador instalado requiere un ABI que
 * este runtime no soporta. El plugin lo llama al inicializarse para que un
 * par plugin↔compiler desalineado falle en el arranque, no en el navegador.
 */
export function assertCompilerAbi(required: number, supported: number): void {
  if (required !== supported) {
    throw new Error(
      `[elur] @elurjs/core-compiler genera ABI ${required} pero ` +
        `@elurjs/vite-plugin-elur soporta ${supported}. ` +
        `Alinea las versiones de ambos paquetes.`,
    );
  }
}
