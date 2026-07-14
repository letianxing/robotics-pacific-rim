package core

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"hash"
	"strings"
	"sync"
)

var securityMagic = [4]byte{'P', 'R', 'S', 'C'}

const (
	securityVersion      byte = 1
	securityHeaderLength      = 4 + 1 + 1 + 2 + 1 + 8 + 8 + 12 + 16 + 4
	securityTagLength         = 16
)

type securityAlgorithm byte

const (
	securityAlgorithmAES256GCM securityAlgorithm = 1
	securityAlgorithmAES128GCM securityAlgorithm = 2
)

type securityEnvelope struct {
	Algorithm         securityAlgorithm
	KeyID             string
	SenderID          uint64
	Sequence          uint64
	Nonce             [12]byte
	AADHash           [16]byte
	Ciphertext        []byte
	Tag               []byte
	CiphertextWithTag []byte
}

type SecurityCodec struct {
	profile      *ResolvedSecurityProfile
	binding      SecurityBinding
	senderID     uint64
	sequence     uint64
	replayWindow *replayWindow
	mu           sync.Mutex
}

func NewSecurityCodec(binding SecurityBinding) (*SecurityCodec, error) {
	if binding.Profile == nil {
		return nil, fmt.Errorf("security profile is required")
	}
	senderID, err := randomUint64()
	if err != nil {
		return nil, err
	}
	return &SecurityCodec{
		profile:      binding.Profile,
		binding:      binding,
		senderID:     senderID,
		replayWindow: newReplayWindow(binding.Profile.ReplayWindow),
	}, nil
}

func parseSecurityAlgorithm(value string) (securityAlgorithm, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "aes-256-gcm", "aes_256_gcm":
		return securityAlgorithmAES256GCM, nil
	case "aes-128-gcm", "aes_128_gcm":
		return securityAlgorithmAES128GCM, nil
	default:
		return 0, fmt.Errorf("unsupported security algorithm %q", value)
	}
}

func (a securityAlgorithm) keyLength() int {
	if a == securityAlgorithmAES128GCM {
		return 16
	}
	return 32
}

func (c *SecurityCodec) Encrypt(plaintext []byte, direction string) ([]byte, error) {
	c.mu.Lock()
	c.sequence++
	sequence := c.sequence
	c.mu.Unlock()
	return c.encryptWithOptions(plaintext, direction, c.senderID, sequence, nil)
}

func (c *SecurityCodec) encryptWithOptions(
	plaintext []byte,
	direction string,
	senderID uint64,
	sequence uint64,
	nonce []byte,
) ([]byte, error) {
	keyConfig := c.profile.Keys[c.profile.EncryptKeyID]
	if keyConfig.KeyID == "" {
		return nil, fmt.Errorf("security profile %q encrypt key %q is missing", c.profile.Name, c.profile.EncryptKeyID)
	}
	routeKey := deriveRouteKey(keyConfig.MasterKey, keyConfig.Salt, c.profile, c.binding, c.profile.Algorithm.keyLength())
	block, err := aes.NewCipher(routeKey)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	var nonceBytes [12]byte
	if len(nonce) > 0 {
		if len(nonce) != len(nonceBytes) {
			return nil, fmt.Errorf("nonce must be 12 bytes")
		}
		copy(nonceBytes[:], nonce)
	} else if _, err := rand.Read(nonceBytes[:]); err != nil {
		return nil, err
	}
	aad := c.AAD(direction)
	ciphertextWithTag := aead.Seal(nil, nonceBytes[:], plaintext, aad)
	ciphertextLen := len(ciphertextWithTag) - securityTagLength
	if ciphertextLen < 0 {
		return nil, fmt.Errorf("ciphertext is shorter than GCM tag")
	}
	envelope := securityEnvelope{
		Algorithm:         c.profile.Algorithm,
		KeyID:             keyConfig.KeyID,
		SenderID:          senderID,
		Sequence:          sequence,
		Nonce:             nonceBytes,
		AADHash:           aadHash(aad),
		Ciphertext:        ciphertextWithTag[:ciphertextLen],
		Tag:               ciphertextWithTag[ciphertextLen:],
		CiphertextWithTag: ciphertextWithTag,
	}
	return marshalSecurityEnvelope(envelope), nil
}

func (c *SecurityCodec) Decrypt(encrypted []byte, direction string) ([]byte, error) {
	envelope, err := unmarshalSecurityEnvelope(encrypted)
	if err != nil {
		return nil, err
	}
	if envelope.Algorithm != c.profile.Algorithm {
		return nil, fmt.Errorf("security algorithm mismatch: got %d want %d", envelope.Algorithm, c.profile.Algorithm)
	}
	aad := c.AAD(direction)
	expectedAADHash := aadHash(aad)
	if !bytes.Equal(envelope.AADHash[:], expectedAADHash[:]) {
		return nil, fmt.Errorf("security AAD hash mismatch")
	}
	keyConfig := c.profile.Keys[envelope.KeyID]
	if keyConfig.KeyID == "" {
		return nil, fmt.Errorf("security key %q is not configured for profile %q", envelope.KeyID, c.profile.Name)
	}
	routeKey := deriveRouteKey(keyConfig.MasterKey, keyConfig.Salt, c.profile, c.binding, c.profile.Algorithm.keyLength())
	block, err := aes.NewCipher(routeKey)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	ciphertextWithTag := append(append([]byte(nil), envelope.Ciphertext...), envelope.Tag...)
	plaintext, err := aead.Open(nil, envelope.Nonce[:], ciphertextWithTag, aad)
	if err != nil {
		return nil, fmt.Errorf("security decrypt failed: %w", err)
	}
	if !c.replayWindow.Accept(envelope.SenderID, envelope.Sequence) {
		return nil, fmt.Errorf("security replay rejected")
	}
	return plaintext, nil
}

func (c *SecurityCodec) AAD(direction string) []byte {
	return BuildSecurityAAD(c.profile.Name, c.binding, direction, c.profile.AADContext)
}

func BuildSecurityAAD(profileName string, binding SecurityBinding, direction string, context string) []byte {
	lines := []string{
		"pacific-rim|comm-security|v1",
		"profile=" + profileName,
		"route=" + binding.Route,
		"binding=" + binding.Binding,
		"transport=" + binding.Transport,
		"address=" + binding.Address,
		"message_type=" + binding.MessageType,
		"direction=" + direction,
	}
	if strings.TrimSpace(context) != "" {
		lines = append(lines, "context="+strings.TrimSpace(context))
	}
	return []byte(strings.Join(lines, "\n"))
}

func marshalSecurityEnvelope(envelope securityEnvelope) []byte {
	keyID := []byte(envelope.KeyID)
	out := make([]byte, 0, securityHeaderLength+len(keyID)+len(envelope.Ciphertext)+len(envelope.Tag))
	out = append(out, securityMagic[:]...)
	out = append(out, securityVersion)
	out = append(out, byte(envelope.Algorithm))
	out = appendLittleEndianUint16(out, 0)
	out = append(out, byte(len(keyID)))
	out = appendLittleEndianUint64(out, envelope.SenderID)
	out = appendLittleEndianUint64(out, envelope.Sequence)
	out = append(out, envelope.Nonce[:]...)
	out = append(out, envelope.AADHash[:]...)
	out = appendLittleEndianUint32(out, uint32(len(envelope.Ciphertext)))
	out = append(out, keyID...)
	out = append(out, envelope.Ciphertext...)
	out = append(out, envelope.Tag...)
	return out
}

func appendLittleEndianUint16(out []byte, value uint16) []byte {
	var encoded [2]byte
	binary.LittleEndian.PutUint16(encoded[:], value)
	return append(out, encoded[:]...)
}

func appendLittleEndianUint32(out []byte, value uint32) []byte {
	var encoded [4]byte
	binary.LittleEndian.PutUint32(encoded[:], value)
	return append(out, encoded[:]...)
}

func appendLittleEndianUint64(out []byte, value uint64) []byte {
	var encoded [8]byte
	binary.LittleEndian.PutUint64(encoded[:], value)
	return append(out, encoded[:]...)
}

func unmarshalSecurityEnvelope(data []byte) (securityEnvelope, error) {
	if len(data) < securityHeaderLength+securityTagLength {
		return securityEnvelope{}, fmt.Errorf("security envelope is too short")
	}
	if !bytes.Equal(data[:4], securityMagic[:]) {
		return securityEnvelope{}, fmt.Errorf("security envelope magic mismatch")
	}
	offset := 4
	version := data[offset]
	offset++
	if version != securityVersion {
		return securityEnvelope{}, fmt.Errorf("unsupported security envelope version %d", version)
	}
	envelope := securityEnvelope{Algorithm: securityAlgorithm(data[offset])}
	offset++
	offset += 2
	keyIDLen := int(data[offset])
	offset++
	envelope.SenderID = binary.LittleEndian.Uint64(data[offset : offset+8])
	offset += 8
	envelope.Sequence = binary.LittleEndian.Uint64(data[offset : offset+8])
	offset += 8
	copy(envelope.Nonce[:], data[offset:offset+12])
	offset += 12
	copy(envelope.AADHash[:], data[offset:offset+16])
	offset += 16
	ciphertextLen := int(binary.LittleEndian.Uint32(data[offset : offset+4]))
	offset += 4
	if keyIDLen == 0 {
		return securityEnvelope{}, fmt.Errorf("security envelope key_id is empty")
	}
	if ciphertextLen < 0 || len(data) != offset+keyIDLen+ciphertextLen+securityTagLength {
		return securityEnvelope{}, fmt.Errorf("security envelope length mismatch")
	}
	envelope.KeyID = string(data[offset : offset+keyIDLen])
	offset += keyIDLen
	envelope.Ciphertext = append([]byte(nil), data[offset:offset+ciphertextLen]...)
	offset += ciphertextLen
	envelope.Tag = append([]byte(nil), data[offset:offset+securityTagLength]...)
	envelope.CiphertextWithTag = append(append([]byte(nil), envelope.Ciphertext...), envelope.Tag...)
	return envelope, nil
}

func aadHash(aad []byte) [16]byte {
	sum := sha256.Sum256(aad)
	var out [16]byte
	copy(out[:], sum[:16])
	return out
}

func deriveRouteKey(masterKey []byte, salt []byte, profile *ResolvedSecurityProfile, binding SecurityBinding, length int) []byte {
	info := []byte("pacific-rim:comm-security:v1:" + profile.Name + ":" + binding.Route + ":" + binding.MessageType)
	return hkdfSHA256(masterKey, salt, info, length)
}

func hkdfSHA256(secret []byte, salt []byte, info []byte, length int) []byte {
	if salt == nil {
		salt = make([]byte, sha256.Size)
	}
	prk := hmacBytes(sha256.New, salt, secret)
	out := make([]byte, 0, length)
	previous := []byte{}
	counter := byte(1)
	for len(out) < length {
		h := hmac.New(sha256.New, prk)
		h.Write(previous)
		h.Write(info)
		h.Write([]byte{counter})
		previous = h.Sum(nil)
		out = append(out, previous...)
		counter++
	}
	return out[:length]
}

func hmacBytes(newHash func() hash.Hash, key []byte, data []byte) []byte {
	h := hmac.New(newHash, key)
	h.Write(data)
	return h.Sum(nil)
}

type replayWindow struct {
	limit uint64
	mu    sync.Mutex
	seen  map[uint64]map[uint64]struct{}
}

func newReplayWindow(limit uint64) *replayWindow {
	if limit == 0 {
		limit = 4096
	}
	return &replayWindow{limit: limit, seen: map[uint64]map[uint64]struct{}{}}
}

func (w *replayWindow) Accept(senderID uint64, sequence uint64) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	sequences := w.seen[senderID]
	if sequences == nil {
		sequences = map[uint64]struct{}{}
		w.seen[senderID] = sequences
	}
	if _, ok := sequences[sequence]; ok {
		return false
	}
	sequences[sequence] = struct{}{}
	if uint64(len(sequences)) > w.limit {
		var min uint64
		for seq := range sequences {
			if min == 0 || seq < min {
				min = seq
			}
		}
		delete(sequences, min)
	}
	return true
}
