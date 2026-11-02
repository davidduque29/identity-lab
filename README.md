# Identity Lab

Demo educativa de biometría facial: captura desde webcam o cámara frontal, registro de tres muestras y comparación 1:1 en el navegador. No necesita AWS, claves de API ni un backend.

## Ejecutar en tu computador

Requisitos: Python 3, conexión a Internet para descargar los assets inicialmente, navegador moderno y cámara.

```bash
git clone https://github.com/davidduque29/identity-lab.git
cd identity-lab
python scripts/download_assets.py
python -m http.server 8000 --directory dist
```

En Windows puedes usar `py` en lugar de `python`. Abre **http://localhost:8000** en el mismo computador. Usa localhost o un despliegue HTTPS: una dirección HTTP de la red local no suele permitir cámara en el celular.

1. Espera el mensaje «Motor local listo».
2. Marca la autorización y activa la cámara.
3. Pulsa **Capturar y registrar mi rostro**, debajo de la cámara.
4. Mantén un único rostro centrado mientras se toman tres muestras.
5. Pulsa **Comparar nueva captura**.
6. Abre «Fotos y comparación»: verás las tres referencias y la captura nueva. Pulsa una imagen para ampliarla e inspeccionar el vector.
7. Consulta cada distancia, el promedio y el umbral usado. Puedes revisar los últimos cinco intentos; volver a registrar borra el historial anterior.

## Cómo funciona

- `dist/index.html` y `dist/style.css`: interfaz responsive.
- `dist/app.js`: cámara, captura en canvas, registro temporal, comparación y bitácora.
- Adaptador `adapter`: carga del motor, captura de descriptor y distancia euclidiana.
- face-api.js 0.22.2: TinyFaceDetector, FaceLandmark68Net y FaceRecognitionNet.
- Cada muestra genera un vector de 128 valores. El resultado usa la media de las distancias contra las tres referencias.
- Umbral inicial 0.50, ajustable, experimental y sin calibración FAR/FRR. La distancia no es un porcentaje de certeza.

Los assets se descargan desde el proyecto original y jsDelivr. `scripts/assets.json` fija el SHA-256 de cada archivo; si el contenido cambia, el instalador falla en lugar de aceptar una versión distinta. Las rutas de pesos del proveedor usan su rama master y podrían dejar de servir los mismos bytes; en ese caso hay que revisar y actualizar explícitamente los assets. Los archivos descargados quedan fuera de Git.

## Privacidad y alcance

Las capturas y vectores se procesan en el navegador. No se suben imágenes al servidor, no hay analítica y no se usan localStorage ni IndexedDB. Se conservan temporalmente las tres fotos de referencia y hasta cinco capturas de comparación, junto con sus vectores, horas y resultados. Las fotos mostradas corresponden al mismo fotograma usado en la extracción del vector. El recuadro indica el rostro detectado y las imágenes se muestran sin espejo.

Recargar, cerrar o borrar elimina las referencias e intentos de la aplicación. El botón de borrado también vacía la galería y los detalles ampliados. Volver a registrar reemplaza las referencias y borra el historial; apagar la cámara conserva la sesión para inspección. La cámara se apaga al ocultar la página.

Esta demo compara semejanza facial; **no acredita identidad legal ni implementa prueba de vida**. Fotos, videos o una cámara manipulada podrían engañarla. No usar como autenticación de producción ni para proteger documentos reales o recuperar cuentas.

## Evolución prevista

Un backend Java/Spring y un motor local Python/OpenCV serían una etapa posterior. El prototipo actual utiliza JavaScript por las capacidades de Sites. La sustitución por SFace, AWS u otro proveedor exige adaptar captura, contratos y umbrales; los vectores de distintos modelos no son intercambiables. La prueba de vida debe desarrollarse y evaluarse por separado.

## Validación de esta entrega

Sintaxis JavaScript y Python comprobadas; integridad y disponibilidad de los assets comprobadas. Interfaz, carga de los tres modelos y autorización previa verificadas en navegador. La captura y comparación completas requieren validación en el dispositivo real del usuario; no se declara precisión ni resistencia a suplantación.

## Licencias

face-api.js pertenece a su proyecto original: https://github.com/justadudewhohacks/face-api.js . Se incluye su licencia en `dist/vendor/LICENSE-face-api.txt`. Revisar las condiciones de los modelos y dependencias antes de una distribución o uso productivo. Esta entrega no asigna una licencia nueva al código propio.

## Pruebas de sesión

Con Node.js instalado:

```bash
node --test tests/session.test.cjs
```

Valida la media de las tres distancias, la asociación de fotos y vectores, el umbral guardado por intento, el límite de cinco intentos y el borrado incluso con una inferencia pendiente. Usa un motor simulado; no mide precisión biométrica ni sustituye la prueba en cámara real.
