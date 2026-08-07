package pt.nmcf.navegante

/** Small hex helpers used across the app. */
object Hex {
    private val HEX = "0123456789ABCDEF".toCharArray()

    fun encode(bytes: ByteArray, from: Int = 0, to: Int = bytes.size): String {
        val sb = StringBuilder((to - from) * 2)
        for (i in from until to) {
            val v = bytes[i].toInt() and 0xFF
            sb.append(HEX[v ushr 4])
            sb.append(HEX[v and 0x0F])
        }
        return sb.toString()
    }

    fun encodeSpaced(bytes: ByteArray, from: Int = 0, to: Int = bytes.size): String {
        val sb = StringBuilder()
        for (i in from until to) {
            if (i > from) sb.append(' ')
            val v = bytes[i].toInt() and 0xFF
            sb.append(HEX[v ushr 4])
            sb.append(HEX[v and 0x0F])
        }
        return sb.toString()
    }

    fun decode(s: String): ByteArray {
        val clean = s.replace(" ", "")
        val out = ByteArray(clean.length / 2)
        var i = 0
        while (i < out.size) {
            out[i] = ((Character.digit(clean[i * 2], 16) shl 4) +
                    Character.digit(clean[i * 2 + 1], 16)).toByte()
            i++
        }
        return out
    }

    /** Big-endian unsigned integer from a slice of [bytes]. */
    fun uint(bytes: ByteArray, from: Int, len: Int): Long {
        var v = 0L
        for (i in 0 until len) {
            v = (v shl 8) or (bytes[from + i].toLong() and 0xFF)
        }
        return v
    }
}
