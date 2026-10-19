# Frasco

Marketplace mobile-first para publicar y explorar frascos y botellas de vidrio reutilizables. La aplicación es HTML, CSS y JavaScript estáticos; Supabase proporciona autenticación, PostgreSQL con RLS y almacenamiento de fotos.

## Arquitectura

```text
index.html / styles.css / app.js       Interfaz estática en español
supabase-config.js                     URL y clave pública del cliente Supabase
supabase/schema.sql                    Tablas, funciones, Storage y políticas RLS
manifest.webmanifest / sw.js            Instalación PWA y caché de la interfaz
```

El catálogo es público. Para publicar, guardar favoritos o reportar un anuncio hace falta una cuenta. El nombre del vendedor y su WhatsApp solo aparecen en anuncios activos cuando el vendedor habilita expresamente la opción en su perfil. Frasco no cobra, verifica ventas ni organiza retiros o entregas.

## Requisitos

- Un proyecto Supabase.
- Un navegador moderno.
- Python 3, Node.js o cualquier servidor HTTP local para probar módulos ES (no abras `index.html` con `file://`).
- Una cuenta de hosting estático si querés publicarlo; la app puede servirse desde GitHub Pages o Vercel.

## Configuración local

1. Creá un proyecto en Supabase y guardá la URL del proyecto y su clave **publishable/anon**.
2. En Supabase, abrí **SQL Editor**, pegá y ejecutá [`supabase/schema.sql`](./supabase/schema.sql) usando la cuenta propietaria del proyecto.
3. Reemplazá los dos valores de [`supabase-config.js`](./supabase-config.js):

   ```js
   export const SUPABASE_URL = "https://TU_PROJECT_REF.supabase.co";
   export const SUPABASE_ANON_KEY = "TU_CLAVE_PUBLICA";
   ```

   La clave publishable/anon está diseñada para usarse en el navegador y **no es una clave secreta**. Nunca pongas una `service_role` o una clave secreta en este archivo, en el HTML o en el hosting.

4. En **Authentication → URL Configuration**, agregá la URL de desarrollo (por ejemplo, `http://localhost:8000/`) y la URL final del sitio en **Redirect URLs**. Habilitá el proveedor Email y configurá la confirmación de correo según la política que quieras usar. La recuperación de contraseña vuelve a la misma página.
5. Desde la carpeta del proyecto, iniciá un servidor local:

   ```powershell
   py -m http.server 8000
   ```

   Abrí `http://localhost:8000/`. También podés usar otro servidor estático que sirva los archivos como módulos ES.
6. Registrá una cuenta, confirmá el correo si está habilitado y completá el perfil. El catálogo real aparece cuando hay publicaciones activas.

La configuración de Supabase ausente se muestra en la página; no se reemplaza por publicaciones ficticias ni almacenamiento local.

## Despliegue

1. Publicá los archivos de este proyecto en la raíz del sitio estático. No hace falta compilar ni instalar dependencias.
2. Configurá `supabase-config.js` con la URL y la clave pública del mismo proyecto.
3. Agregá la URL HTTPS de producción a **Authentication → URL Configuration → Redirect URLs** y establecela como **Site URL**.
4. Probá registro, confirmación, recuperación de contraseña, publicación, filtros, fotos y cierre de sesión en el sitio publicado.
5. Serví el sitio por HTTPS. El service worker solo se registra en HTTPS o en `localhost`.

La app no usa `process.env` ni lee variables de entorno del hosting: la URL y la clave pública deben estar disponibles al cliente en tiempo de ejecución. No agregues credenciales privilegiadas a la configuración estática.

## Configuración de moderación

Los reportes se guardan en `public.reports`. Para asignar una persona moderadora, primero creá su cuenta y luego ejecutá en el SQL Editor como propietaria del proyecto:

```sql
update public.profiles
set role = 'moderator'
where id = (
  select id from auth.users where email = 'correo-de-la-persona@example.com'
);
```

El cambio de rol no está disponible desde el navegador. No asignes `admin` o `moderator` a cuentas que no controles. Las personas moderadoras pueden revisar reportes y gestionar anuncios mediante las políticas RLS.

## Seguridad y datos

- RLS está habilitado para perfiles, anuncios, fotos, favoritos y reportes.
- Cada usuario solo puede crear/modificar/eliminar sus anuncios y favoritos. El navegador no recibe permisos para cambiar roles.
- El reporte requiere sesión, un anuncio activo de otra persona y permite un reporte por usuario/anuncio.
- El bucket `listing-images` es privado. El catálogo obtiene URLs firmadas de cinco minutos solo para fotos de anuncios activos; propietarios y moderadores pueden acceder a las fotos de sus anuncios independientemente del estado. La carga se limita a imágenes JPG/PNG/WebP de hasta 5 MB y las escrituras/eliminaciones se limitan al propietario del anuncio. No subas imágenes privadas ni con datos personales.
- Los anuncios solo guardan una etiqueta de ubicación aproximada; no solicitan coordenadas ni direcciones exactas.
- No se registra una venta por un clic en WhatsApp. Las operaciones, el conteo de consultas y las métricas comerciales no están integradas.
- La interfaz implementa consentimiento explícito para mostrar el nombre y WhatsApp, pero eso no sustituye una política de privacidad, términos, un canal de contacto ni una revisión de cumplimiento de la Ley argentina 25.326. Preparalos y revisalos antes de captar usuarios reales.
- Las funciones SQL usan privilegios limitados y la búsqueda pública filtra solo anuncios activos. No expongas la clave `service_role` en la aplicación.

## Funciones implementadas

- Registro, inicio/cierre de sesión, confirmación por correo y recuperación/cambio de contraseña mediante Supabase Auth.
- Perfil editable con nombre, WhatsApp y autorización separada para mostrar los datos de contacto.
- Catálogo público con búsqueda por título/descripción y filtros por categoría, precio, cantidad, ubicación y orden.
- Publicación, edición, hasta cinco fotos, marcado como vendido, archivado/reactivación y eliminación.
- Favoritos, detalle de anuncio, contacto por WhatsApp con texto inicial y reportes de contenido.
- Panel de revisión de reportes para roles `moderator`/`admin`.
- Manifest, icono y caché offline del shell de la aplicación. La caché no guarda el catálogo, imágenes ni datos de sesión para uso sin conexión.

## Verificación manual antes de lanzar

1. Sin configurar Supabase, confirmar que la web avisa que falta conectar el backend y no muestra anuncios de ejemplo.
2. Conectar el proyecto y comprobar que una persona visitante puede explorar el catálogo sin iniciar sesión.
3. Crear dos cuentas. Confirmar que una no puede editar/eliminar publicaciones de la otra ni consultar su teléfono si no hay consentimiento.
4. Crear un anuncio, probar los filtros y comprobar paginación con más de 12 anuncios.
5. Probar JPG, PNG y WebP menores a 5 MB; verificar que se rechacen archivos no permitidos y una sexta imagen.
6. Editar, archivar, reactivar, marcar vendido y eliminar un anuncio. Confirmar que archivados/vendidos no aparezcan en el catálogo público.
7. Probar favoritos, reporte duplicado, recuperación de contraseña y las opciones de moderación.
8. Revisar las políticas y las URL de redirección en Supabase antes de habilitar usuarios reales.

## Límites conocidos y próximos pasos

- Esta versión no incorpora pagos, logística, chat interno, moderación automática, analítica/GA4, métricas de ventas, panel de operaciones ni administración de roles desde la web.
- Las fotos se sirven mediante URLs firmadas de corta duración sujetas a las políticas de Storage. La eliminación de un anuncio borra los metadatos de sus imágenes; el navegador intenta borrar también los objetos. Si falla la limpieza de Storage, el anuncio ya eliminado puede dejar objetos huérfanos que una persona administradora tendrá que retirar.
- El service worker usa caché-first para los archivos estáticos. Al actualizar la app, incrementá `CACHE_NAME` en `sw.js` para que las instalaciones existentes descarguen la versión nueva.
- La interfaz todavía necesita revisión de accesibilidad con lectores de pantalla y pruebas en dispositivos reales antes de un lanzamiento público.
