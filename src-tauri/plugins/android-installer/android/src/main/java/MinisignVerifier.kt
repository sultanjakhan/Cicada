package app.hanni.mvp.android.installer

import org.bouncycastle.crypto.digests.Blake2bDigest
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.io.File
import java.util.Base64

/** Strict subset used by minisign-verify 0.2.5 in the Rust updater. */
internal object MinisignVerifier {
    private val base64 = Regex("[A-Za-z0-9+/]*={0,2}")

    /** Input is the base64 wire value carried by Tauri's pubkey and manifest. */
    fun verifyFile(file: File, publicKeyWire: String, signatureWire: String) {
        val key = parsePublicKey(decodeOuter(publicKeyWire))
        val signature = parseSignature(decodeOuter(signatureWire))
        require(signature.keyId.contentEquals(key.keyId)) { "Update signing key id does not match" }
        val message = when (signature.algorithm) {
            "ED" -> blake2b512(file)
            "Ed" -> file.readBytes()
            else -> throw IllegalArgumentException("Unsupported update signature algorithm")
        }
        require(verify(key.publicKey, message, signature.signature)) { "Update package signature is invalid" }
        val globalMessage = signature.signature + signature.trustedComment.toByteArray(Charsets.UTF_8)
        require(verify(key.publicKey, globalMessage, signature.globalSignature)) { "Update global signature is invalid" }
    }

    private fun parsePublicKey(value: String): PublicKey {
        val lines = strictLines(value, 2)
        val raw = decode(lines[1])
        require(raw.size == 42 && raw[0] == 'E'.code.toByte() && raw[1] == 'd'.code.toByte()) { "Invalid update public key" }
        return PublicKey(raw.copyOfRange(2, 10), raw.copyOfRange(10, 42))
    }

    private fun parseSignature(value: String): Signature {
        val lines = strictLines(value, 4)
        require(lines[2].startsWith("trusted comment: ")) { "Invalid trusted update comment" }
        val raw = decode(lines[1])
        require(raw.size == 74) { "Invalid update signature" }
        val algorithm = String(raw.copyOfRange(0, 2), Charsets.US_ASCII)
        require(algorithm == "ED" || algorithm == "Ed") { "Unsupported update signature algorithm" }
        return Signature(
            algorithm,
            raw.copyOfRange(2, 10),
            raw.copyOfRange(10, 74),
            lines[2].removePrefix("trusted comment: "),
            decode(lines[3]).also { require(it.size == 64) { "Invalid global update signature" } },
        )
    }

    private fun strictLines(value: String, count: Int): List<String> {
        val normalized = value.removeSuffix("\n").removeSuffix("\r")
        val lines = normalized.split('\n')
        require(lines.size == count && lines.none { it.endsWith('\r') || it.isEmpty() }) { "Invalid update signature envelope" }
        return lines
    }

    private fun decode(value: String): ByteArray {
        require(value.isNotEmpty() && base64.matches(value) && value.length % 4 == 0) { "Invalid update base64" }
        return try { Base64.getDecoder().decode(value) } catch (_: IllegalArgumentException) {
            throw IllegalArgumentException("Invalid update base64")
        }
    }

    private fun decodeOuter(value: String): String = try {
        String(decode(value), Charsets.UTF_8)
    } catch (_: Exception) { throw IllegalArgumentException("Invalid update signature envelope") }

    private fun blake2b512(file: File): ByteArray {
        val digest = Blake2bDigest(512)
        file.inputStream().buffered().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return ByteArray(64).also { digest.doFinal(it, 0) }
    }

    private fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean {
        val verifier = Ed25519Signer()
        verifier.init(false, Ed25519PublicKeyParameters(publicKey, 0))
        verifier.update(message, 0, message.size)
        return verifier.verifySignature(signature)
    }

    private data class PublicKey(val keyId: ByteArray, val publicKey: ByteArray)
    private data class Signature(
        val algorithm: String,
        val keyId: ByteArray,
        val signature: ByteArray,
        val trustedComment: String,
        val globalSignature: ByteArray,
    )
}
