# Identity Lab

Demo pública de registro y comparación facial: GitHub Pages + GitHub Actions + Supabase.

URL de despliegue: https://davidduque29.github.io/identity-lab/

## Flujo

1. Abre la cámara y centra el rostro. Tras estabilidad, se muestra «No te muevas», cuenta 3–2–1 y toma **una** foto.
2. Completa y confirma los datos. El servidor impide duplicados por tipo y número de documento normalizado. Si ya existe, ofrece «Usar mi registro y comparar» y no guarda otra foto.
3. Pulsa «Continuar con la segunda foto». Hace una captura nueva automática y compara su descriptor con la referencia.
4. Muestra ambas miniaturas, un índice de similitud orientativo y, solo si coincide, los datos registrados. La cámara se apaga.

Al regresar con la misma sesión de visitante, detecta un registro previo y ofrece comparar directamente. Desde otro navegador se busca por documento. No identifica duplicados por parecido facial: distintos documentos podrían registrar el mismo rostro.

El QR apunta a `portal.html#qr=<token aleatorio>`, vence, se reclama una sola vez y funciona sin ChatGPT. El token se retira de la barra y pasa a la memoria de sesión del navegador. El equipo que lo genera recibe estado, no los datos de la persona.

## Arquitectura y adaptadores

- `public/`: interfaz estática; `transport.js` encapsula API, sesión y carga autorizada de imágenes; `deployment-config.js` contiene URL y **clave publicable**, nunca un secreto.
- `server/domain.mjs`: validaciones, comparación, contador y reglas sin dependencia del proveedor.
- `server/lab.mjs`: casos de uso compartidos con puertos `DB` y `STORAGE`.
- `supabase/functions/identity-api/index.ts`: adaptadores de identidad, base de datos y archivos. La clave de servicio permanece en el entorno de Edge Functions.
- PostgreSQL: esquema `identity_private`, RLS activado, sin acceso directo de anon/authenticated. RPC invoker de sentencias fijas enumeradas y valores escapados, solo ejecutable por service_role; cada batch es una transacción. No existe un endpoint público para ejecutar SQL.
- Storage: bucket privado `identity-lab`; una referencia y plantilla por perfil, avatar separado. No se persiste la foto de comparación.
- Administración: Supabase Auth verifica correo; la dirección autorizada está en configuración privada del servidor, no en metadatos editables del usuario.
- Visitantes: capacidades aleatorias de 24 horas, guardadas por hash en el servidor. No se necesita una cuenta de ChatGPT.

Los registros de esta demo son compartidos dentro de su único tenant: un visitante puede buscar un documento y comparar. El listado, las plantillas, las fotos administrativas y la edición están restringidos al administrador. **No usar esta demo para autenticar servicios reales:** no hay prueba de vida, comprobación documental ni extracción confiable de la plantilla en el servidor. El descriptor llega del cliente. El índice porcentual no es probabilidad ni exactitud validada.

## Datos

Una referencia JPEG/PNG, 128 valores del descriptor, datos declarados, consentimiento, fecha y auditoría. La foto nueva de comparación solo se muestra en memoria de la pestaña. Las sustituciones de referencia necesitan autorización administrativa. Unicidad del documento y contadores se controlan en el servidor, también con solicitudes concurrentes.

La captura de IP **está pendiente de verificar en el nuevo gateway**. Se devuelve «no disponible» y no se confía en una cabecera X-Forwarded-For enviada por el cliente. No se presenta una IP inventada ni heredada de Sites.

Los registros previos de ChatGPT Sites no se han exportado ni migrado. Permanecen allí; la base nueva es independiente de Sites y de Orbit Tasks. No hay conexión activa con Drive; el adaptador de archivos permite incorporar otro destino sin cambiar la captura.

## Desarrollo

### Documentación por rol

`documentation.html` aparece junto a Mi historial. El catálogo y las descargas se validan en el servidor: una cuenta confirmada ve las guías de usuario y el administrador ve además sus manuales. Los visitantes deben iniciar sesión. La sección de usuario comienza vacía hasta publicar sus guías.

El catálogo privado está en `identity_private.configuration`, clave `identity-lab-david:documentation`. Cada entrada contiene `id`, `audience` (`admin` o `user`), `title`, `description`, `version`, `updatedAt` (ISO), `filename`, `contentType` y `size` (bytes). El documento correspondiente usa la clave `identity-lab-david:document:<id>` con un objeto `{ "content": "<base64>" }`. Para estos manuales pequeños se reutiliza la configuración privada; publicar primero el archivo completo y comprobar su integridad antes de añadir la entrada al catálogo. Para una biblioteca grande, mover los bytes a Storage privado manteniendo el contrato de autorización.

`GET action=documentation` devuelve solo metadatos permitidos. `GET action=documentation-file&id=...` comprueba de nuevo el rol y devuelve el archivo como adjunto sin caché. Los manuales, sus bytes y enlaces de Drive no se guardan en el repositorio público ni en Pages. El documento publicado es una copia descargable de la versión proporcionada; los cambios posteriores en Drive no se sincronizan automáticamente y no se cambian sus permisos de origen.

Node 24 y Python 3:

```sh
npm ci
npm test
npm run assets
npm run build
```

`pages-dist/` contiene únicamente archivos públicos y se excluye de Git. El instalador descarga los modelos y face-api.js 0.22.2 y comprueba SHA-256. `scripts/build-pages.mjs` copia el servicio compartido a la carpeta de la función para su despliegue; esas copias son generadas, no se mantienen a mano.

`drizzle/*.sql` conserva exclusivamente el esquema SQLite de las pruebas del servicio compartido; no es la base de producción. La instalación PostgreSQL inicial está en `supabase/schema.sql`. Al añadir una sentencia al servicio, actualizar la lista explícita de sentencias permitidas y aplicar su migración en Supabase.

## Despliegue

- `.github/workflows/deploy-pages.yml`: push a main → npm ci → pruebas → descarga verificada → build → GitHub Pages. Configurar Settings → Pages → Source: **GitHub Actions** una vez.
- `.github/workflows/deploy-backend.yml`: despliegue manual o por cambios del servidor, con `SUPABASE_ACCESS_TOKEN` como Actions Secret y `SUPABASE_AUTODEPLOY=true` como variable del repositorio. Hasta configurarlos se conserva el backend ya desplegado. La clave de servicio no va a GitHub Pages. Cambios de esquema se aplican mediante migraciones separadas, nunca automáticamente desde el navegador.
- Proyecto Supabase independiente: `hckqcyhsnuwblwjvqpdi`, región São Paulo.
- Configurar en Supabase Authentication → URL Configuration el Site URL `https://davidduque29.github.io/identity-lab/` y Redirect URL `https://davidduque29.github.io/identity-lab/admin-login.html`.
- El administrador puede entrar desde el menú con el enlace de correo o código. Para enviar un código visible, la plantilla de correo debe incluir `{{ .Token }}`; el enlace también está soportado por `admin-login.html`.

El primer backend se desplegó con la conexión de Supabase. La configuración del correo y el inicio administrativo real requieren verificación por el titular de la cuenta. No compartir contraseñas, OTP ni claves de servicio en el chat.
