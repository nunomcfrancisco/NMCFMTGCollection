package pt.nmcf.navegante

import android.nfc.tech.IsoDep

/**
 * Reads a Calypso transit card (navegante / Lisboa Viva) over ISO 14443-4 (IsoDep).
 *
 * The card is a Calypso card. For these transit files, READ RECORD is allowed
 * without opening a secure session, so we can dump the accessible EFs by brute
 * force: SELECT the transport application (AID "1TIC.ICA") and then try to read
 * records across every SFI.
 *
 * The exact byte layout of the "zapping" balance is NOT publicly documented for
 * navegante, so [CardResult.candidates] lists every plausible value found in the
 * counter files, and the full hex dump is kept so parsing can be refined against
 * a real card.
 */
object CalypsoReader {

    /** Standard Calypso transport application: ASCII "1TIC.ICA". */
    private val AID_1TIC_ICA = byteArrayOf(
        0x31, 0x54, 0x49, 0x43, 0x2E, 0x49, 0x43, 0x41
    )

    data class Record(val sfi: Int, val record: Int, val data: ByteArray)

    /** A plausible balance value found in the card, in euro cents. */
    data class BalanceCandidate(val sfi: Int, val record: Int, val cents: Long) {
        fun euros(): String = String.format("%.2f", cents / 100.0)
    }

    data class CardResult(
        val selected: Boolean,
        val fci: ByteArray?,
        val records: List<Record>,
        val candidates: List<BalanceCandidate>,
        val log: String
    )

    fun read(tag: IsoDep): CardResult {
        val log = StringBuilder()
        tag.timeout = 2000
        tag.connect()
        try {
            // 1) SELECT the Calypso transport application.
            val selectResp = transceive(tag, buildSelect(AID_1TIC_ICA), log, "SELECT 1TIC.ICA")
            val selected = sw(selectResp) == 0x9000
            val fci = if (selected) selectResp.copyOf(selectResp.size - 2) else null

            val records = mutableListOf<Record>()
            if (selected) {
                // 2) Brute-force dump: try every SFI, records 1..N.
                for (sfi in 1..31) {
                    var rec = 1
                    var emptyStreak = 0
                    while (rec <= 32) {
                        val resp = readRecord(tag, sfi, rec, log)
                        if (resp != null && resp.size > 2) {
                            records.add(Record(sfi, rec, resp.copyOf(resp.size - 2)))
                            emptyStreak = 0
                        } else {
                            // Record/file not found -> stop scanning this SFI early.
                            emptyStreak++
                            if (emptyStreak >= 1) break
                        }
                        rec++
                    }
                }
            }

            val candidates = findBalanceCandidates(records)
            return CardResult(selected, fci, records, candidates, log.toString())
        } finally {
            runCatching { tag.close() }
        }
    }

    private fun buildSelect(aid: ByteArray): ByteArray {
        val apdu = ByteArray(5 + aid.size + 1)
        apdu[0] = 0x00            // CLA
        apdu[1] = 0xA4.toByte()   // INS SELECT
        apdu[2] = 0x04            // P1 select by name (AID)
        apdu[3] = 0x00            // P2 first occurrence
        apdu[4] = aid.size.toByte()
        System.arraycopy(aid, 0, apdu, 5, aid.size)
        apdu[apdu.size - 1] = 0x00 // Le
        return apdu
    }

    /** READ RECORD P1=record, P2=(SFI<<3)|4 (read single record from SFI). */
    private fun readRecord(tag: IsoDep, sfi: Int, record: Int, log: StringBuilder): ByteArray? {
        val p2 = ((sfi shl 3) or 0x04) and 0xFF
        var apdu = byteArrayOf(0x00, 0xB2.toByte(), record.toByte(), p2.toByte(), 0x00)
        var resp = transceive(tag, apdu, log, "READ SFI=%02X rec=%d".format(sfi, record))
        val status = sw(resp)
        if ((status and 0xFF00) == 0x6C00) {
            // Wrong Le: retry with the length the card told us.
            val le = status and 0xFF
            apdu = byteArrayOf(0x00, 0xB2.toByte(), record.toByte(), p2.toByte(), le.toByte())
            resp = transceive(tag, apdu, log, "READ SFI=%02X rec=%d (Le=%02X)".format(sfi, record, le))
        }
        return if (sw(resp) == 0x9000) resp else null
    }

    private fun transceive(tag: IsoDep, apdu: ByteArray, log: StringBuilder, label: String): ByteArray {
        return try {
            val resp = tag.transceive(apdu)
            log.append("> ").append(label).append(": ").append(Hex.encodeSpaced(apdu)).append('\n')
            log.append("< ").append(Hex.encodeSpaced(resp)).append('\n')
            resp
        } catch (e: Exception) {
            log.append("! ").append(label).append(" erro: ").append(e.message).append('\n')
            byteArrayOf(0x6F.toByte(), 0x00)
        }
    }

    private fun sw(resp: ByteArray): Int {
        if (resp.size < 2) return 0
        return ((resp[resp.size - 2].toInt() and 0xFF) shl 8) or (resp[resp.size - 1].toInt() and 0xFF)
    }

    /**
     * Best-effort scan for the zapping balance. In Calypso/Intercode purses the
     * balance is a small counter, usually a 3-byte big-endian value expressed in
     * the fare unit (cents). We surface every plausible value from the counter
     * files (SFIs commonly 0x19..0x1D) so it can be verified against the card.
     */
    private fun findBalanceCandidates(records: List<Record>): List<BalanceCandidate> {
        val out = mutableListOf<BalanceCandidate>()
        for (r in records) {
            // Counter files: read as consecutive 3-byte big-endian values.
            if (r.sfi in 0x19..0x1D && r.data.size >= 3) {
                var i = 0
                while (i + 3 <= r.data.size) {
                    val cents = Hex.uint(r.data, i, 3)
                    if (cents in 1..99999) { // 0.01 .. 999.99 EUR
                        out.add(BalanceCandidate(r.sfi, r.record, cents))
                    }
                    i += 3
                }
            }
        }
        // Most plausible first (typical top-up amounts are a few tens of euros).
        return out.distinctBy { it.cents }.sortedBy { kotlin.math.abs(it.cents - 1500) }
    }
}
