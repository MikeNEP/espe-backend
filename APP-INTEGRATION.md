# Integración con la app ESPE Player

Cómo conectar la app (fork de Wholphin) con este backend para validar la
suscripción **después del login de Jellyfin**.

## Idea general

1. El usuario inicia sesión en Jellyfin desde la app (como siempre).
2. La app llama a `GET /api/v1/status?username=<usuario>` de este backend.
3. Según la respuesta, la app deja pasar o muestra un aviso ("vencido", "suspendido", etc.).

> El bloqueo **real** lo hace Jellyfin: si la suscripción venció, el backend deshabilita
> la cuenta y el usuario no puede reproducir nada. Esta comprobación en la app es para
> **mostrar un mensaje claro** en vez de un error genérico de Jellyfin.

## Contrato del endpoint

**Request**
```
GET /api/v1/status?username=juan
Header (si configuraste APP_KEY): x-app-key: <APP_KEY>
```

**Response 200**
```json
{
  "username": "juan",
  "active": true,
  "status": "activo",          // activo | vencido | baneado | inexistente
  "plan": "mensual",
  "expires_at": "2026-07-30T00:00:00.000Z",
  "days_left": 12,
  "message": "Tu suscripción vence en 12 día(s).",
  "business": "ESPE Player",
  "ts": 1710000000000,          // presentes solo si APP_HMAC_SECRET está seteada
  "signature": "a1b2c3..."      // HMAC-SHA256 de "username|active|expires_at|ts"
}
```

- `active`: úsalo para decidir el acceso en la app.
- `message`: texto listo para mostrar al usuario.
- `signature` (opcional): permite verificar que la respuesta no fue alterada.

### Verificación de la firma (opcional, recomendado en producción)
Canonical string: `` `${username}|${active}|${expires_at}|${ts}` ``
HMAC-SHA256 con `APP_HMAC_SECRET`. Si `signature` no coincide, ignora la respuesta.

## Cliente Kotlin de ejemplo (para la app)

Pega esto en la app (paquete a tu criterio). Sin librerías extra salvo Kotlin coroutines.

```kotlin
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

data class SubStatus(
    val active: Boolean,
    val status: String,
    val message: String,
    val daysLeft: Int,
    val expiresAt: String?,
)

object EspeBackend {
    private const val BASE = "https://TU-DOMINIO"     // tu backend detrás de HTTPS
    private const val APP_KEY = ""                    // igual a APP_KEY del backend (o "")
    private const val HMAC_SECRET = ""                // igual a APP_HMAC_SECRET (o "")

    /** Consulta el estado de la suscripción. Devuelve null si hubo error de red. */
    fun fetchStatus(username: String): SubStatus? {
        return try {
            val u = URL("$BASE/api/v1/status?username=" + URLEncoder.encode(username, "UTF-8"))
            val c = (u.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 8000
                readTimeout = 8000
                if (APP_KEY.isNotEmpty()) setRequestProperty("x-app-key", APP_KEY)
            }
            if (c.responseCode != 200) return null
            val json = JSONObject(c.inputStream.bufferedReader().use { it.readText() })

            // Verificación de firma (si el backend la envía)
            if (HMAC_SECRET.isNotEmpty() && json.has("signature")) {
                val canonical = "${json.optString("username")}|${json.optBoolean("active")}|" +
                    "${json.optString("expires_at")}|${json.optLong("ts")}"
                if (hmacSha256(canonical, HMAC_SECRET) != json.getString("signature")) return null
            }

            SubStatus(
                active = json.optBoolean("active"),
                status = json.optString("status"),
                message = json.optString("message"),
                daysLeft = json.optInt("days_left"),
                expiresAt = json.optString("expires_at", null),
            )
        } catch (e: Exception) {
            null
        }
    }

    private fun hmacSha256(data: String, key: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key.toByteArray(), "HmacSHA256"))
        return mac.doFinal(data.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}
```

### Uso tras el login (ejemplo)
```kotlin
// En una coroutine / hilo de fondo:
val st = EspeBackend.fetchStatus(usernameLogueado)
when {
    st == null -> { /* sin conexión al backend: deja pasar y confía en Jellyfin */ }
    st.active -> {
        if (st.daysLeft in 1..7) showToast(st.message)   // aviso amable
        // continuar al contenido
    }
    else -> showBlockingDialog(st.message)               // vencido/baneado/inexistente
}
```

## Recomendaciones

- Define `APP_KEY` y `APP_HMAC_SECRET` en el backend y en la app para producción.
- Si el backend no responde (offline), **no bloquees** por esto: Jellyfin ya es el candado real.
- El `username` a consultar es el mismo con el que el usuario entró a Jellyfin.
