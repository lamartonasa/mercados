# mercados — robot de datos para lamartonasa.com.ar

Repo hermano del sitio de La Martona S.A. (`la-martona-web`, en esta máquina en
`C:\Users\Oficina\Desktop\CLAUDE\la-martona-web`, rama `master`). Este repo sólo tiene el script
del robot (`scrape.mjs`) y el historial de datos scrapeados como JSON — GitHub Actions lo corre
(`.github/workflows/update.yml`), disparado por el Cron de Vercel del sitio a través de
`/api/robot?mode=X`. El `schedule:` propio de GitHub Actions no se usa — se abandonó por poco
confiable.

**Documentación completa** (fuentes de datos, horarios, infraestructura, límites conocidos) —
Ficha técnica de Mercados: https://claude.ai/code/artifact/5ccbceeb-d910-4b91-8fad-2d2b19eed846

**Infraestructura:** GitHub ya es de la empresa (org `lamartonasa`), no de una cuenta personal.
ScraperAPI (plan gratuito, 1.000 créditos/mes) da proxy cuando una fuente bloquea al robot —
siempre probar lectura directa primero, ScraperAPI es el respaldo, no el default.

## Modos del robot (independientes entre sí)
`node scrape.mjs <modo>`, con modo = `pizarra | dolar | hacienda | arrendamiento | all`.
Horarios (detalle completo en la Ficha técnica): pizarra y dólar corren lunes a viernes; hacienda
y arrendamiento sólo lunes/martes/miércoles/viernes — el MAG no publica remate los jueves.

## Al commitear
Si estás en un sandbox sin credenciales de GitHub, nunca intentes `git push` vos mismo: commitear
y darle a la usuaria el comando exacto de push para que lo corra ella.
