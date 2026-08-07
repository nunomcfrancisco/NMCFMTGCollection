package pt.nmcf.navegante

import android.app.Activity
import android.content.Intent
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.IsoDep
import android.os.Bundle
import android.widget.Button
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity(), NfcAdapter.ReaderCallback {

    private var nfcAdapter: NfcAdapter? = null
    private lateinit var balanceView: TextView
    private lateinit var statusView: TextView
    private lateinit var dumpView: TextView
    private lateinit var scroll: ScrollView
    private lateinit var shareButton: Button

    private var lastDump: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        balanceView = findViewById(R.id.balanceView)
        statusView = findViewById(R.id.statusView)
        dumpView = findViewById(R.id.dumpView)
        scroll = findViewById(R.id.scroll)
        shareButton = findViewById(R.id.shareButton)

        shareButton.setOnClickListener { shareDump() }

        nfcAdapter = NfcAdapter.getDefaultAdapter(this)
        if (nfcAdapter == null) {
            statusView.text = "Este telemóvel não tem NFC."
        } else {
            statusView.text = "Encosta o cartão navegante à traseira do telemóvel."
        }
    }

    override fun onResume() {
        super.onResume()
        val adapter = nfcAdapter ?: return
        if (!adapter.isEnabled) {
            statusView.text = "O NFC está desligado. Ativa-o nas Definições."
            return
        }
        val flags = NfcAdapter.FLAG_READER_NFC_A or
                NfcAdapter.FLAG_READER_NFC_B or
                NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK
        adapter.enableReaderMode(this, this, flags, null)
    }

    override fun onPause() {
        super.onPause()
        nfcAdapter?.disableReaderMode(this)
    }

    /** Called on a background thread when a tag is detected. */
    override fun onTagDiscovered(tag: Tag) {
        val isoDep = IsoDep.get(tag)
        if (isoDep == null) {
            runOnUiThread {
                statusView.text = "Cartão detetado mas não é ISO-DEP/Calypso."
            }
            return
        }
        runOnUiThread { statusView.text = "A ler cartão…" }
        try {
            val result = CalypsoReader.read(isoDep)
            showResult(result)
        } catch (e: Exception) {
            runOnUiThread {
                statusView.text = "Erro na leitura: ${e.message}. Tenta novamente sem mexer o cartão."
            }
        }
    }

    private fun showResult(result: CalypsoReader.CardResult) {
        val sb = StringBuilder()
        if (!result.selected) {
            sb.append("Não foi possível selecionar a aplicação de transporte (1TIC.ICA).\n")
            sb.append("Pode não ser um cartão Calypso compatível.\n\n")
        } else {
            result.fci?.let {
                sb.append("== SELECT FCI ==\n").append(Hex.encodeSpaced(it)).append("\n\n")
            }
            sb.append("== Ficheiros lidos (").append(result.records.size).append(") ==\n")
            for (r in result.records) {
                sb.append("SFI %02X  rec %d:  ".format(r.sfi, r.record))
                sb.append(Hex.encodeSpaced(r.data)).append('\n')
            }
            sb.append('\n')
            sb.append("== Candidatos a saldo (estimativa) ==\n")
            if (result.candidates.isEmpty()) {
                sb.append("Nenhum candidato óbvio nos ficheiros de contador.\n")
            } else {
                for (c in result.candidates) {
                    sb.append("SFI %02X rec %d -> € %s\n".format(c.sfi, c.record, c.euros()))
                }
            }
        }
        sb.append("\n== Log APDU ==\n").append(result.log)

        val dump = sb.toString()
        lastDump = dump

        val bestBalance = result.candidates.firstOrNull()

        runOnUiThread {
            dumpView.text = dump
            shareButton.isEnabled = true
            scroll.post { scroll.fullScroll(ScrollView.FOCUS_UP) }
            if (!result.selected) {
                balanceView.text = "—"
                statusView.text = "Cartão lido, mas sem aplicação de transporte reconhecida."
            } else if (bestBalance != null) {
                balanceView.text = "≈ € ${bestBalance.euros()}"
                statusView.text = "Estimativa do saldo. Confirma no dump se há vários candidatos."
            } else {
                balanceView.text = "?"
                statusView.text = "Cartão lido. Saldo não identificado automaticamente — vê o dump."
            }
        }
    }

    private fun shareDump() {
        if (lastDump.isEmpty()) {
            Toast.makeText(this, "Ainda não há leitura para partilhar.", Toast.LENGTH_SHORT).show()
            return
        }
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "Leitura cartão navegante (NFC)")
            putExtra(Intent.EXTRA_TEXT, lastDump)
        }
        startActivity(Intent.createChooser(intent, "Partilhar leitura"))
    }
}
