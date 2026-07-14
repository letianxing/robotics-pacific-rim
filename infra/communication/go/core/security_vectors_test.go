package core

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type securityVectorFile struct {
	Vectors []securityVector `json:"vectors"`
}

type securityVector struct {
	Name         string `json:"name"`
	Algorithm    string `json:"algorithm"`
	Profile      string `json:"profile"`
	KeyID        string `json:"key_id"`
	MasterKeyB64 string `json:"master_key_b64"`
	SaltB64      string `json:"salt_b64"`
	AADContext   string `json:"aad_context"`
	Route        string `json:"route"`
	Binding      string `json:"binding"`
	Transport    string `json:"transport"`
	Address      string `json:"address"`
	MessageType  string `json:"message_type"`
	Direction    string `json:"direction"`
	SenderID     uint64 `json:"sender_id"`
	Sequence     uint64 `json:"sequence"`
	NonceHex     string `json:"nonce_hex"`
	PlaintextHex string `json:"plaintext_hex"`
	EnvelopeHex  string `json:"envelope_hex"`
}

func TestSecurityCodecVectors(t *testing.T) {
	vectors := loadSecurityVectors(t)
	for _, vector := range vectors {
		t.Run(vector.Name, func(t *testing.T) {
			codec := securityCodecFromVector(t, vector)
			plaintext, err := hex.DecodeString(vector.PlaintextHex)
			if err != nil {
				t.Fatalf("decode plaintext: %v", err)
			}
			nonce, err := hex.DecodeString(vector.NonceHex)
			if err != nil {
				t.Fatalf("decode nonce: %v", err)
			}
			envelope, err := codec.encryptWithOptions(plaintext, vector.Direction, vector.SenderID, vector.Sequence, nonce)
			if err != nil {
				t.Fatalf("encrypt vector: %v", err)
			}
			if vector.EnvelopeHex != "" && hex.EncodeToString(envelope) != vector.EnvelopeHex {
				t.Fatalf("envelope hex mismatch:\ngot  %s\nwant %s", hex.EncodeToString(envelope), vector.EnvelopeHex)
			}
			decrypted, err := codec.Decrypt(envelope, vector.Direction)
			if err != nil {
				t.Fatalf("decrypt vector: %v", err)
			}
			if string(decrypted) != string(plaintext) {
				t.Fatalf("decrypted = %x, want %x", decrypted, plaintext)
			}
			if _, err := codec.Decrypt(envelope, vector.Direction); err == nil {
				t.Fatalf("duplicate envelope should be rejected as replay")
			}
		})
	}
}

func TestSecurityCodecRejectsAADMismatch(t *testing.T) {
	vector := loadSecurityVectors(t)[0]
	codec := securityCodecFromVector(t, vector)
	plaintext, _ := hex.DecodeString(vector.PlaintextHex)
	nonce, _ := hex.DecodeString(vector.NonceHex)
	envelope, err := codec.encryptWithOptions(plaintext, vector.Direction, vector.SenderID, vector.Sequence, nonce)
	if err != nil {
		t.Fatalf("encrypt vector: %v", err)
	}
	if _, err := codec.Decrypt(envelope, "rpc_response"); err == nil {
		t.Fatalf("AAD direction mismatch should fail")
	}
}

func loadSecurityVectors(t *testing.T) []securityVector {
	t.Helper()
	path := filepath.Join("..", "..", "testdata", "security_vectors.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read security vectors: %v", err)
	}
	var file securityVectorFile
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatalf("parse security vectors: %v", err)
	}
	return file.Vectors
}

func securityCodecFromVector(t *testing.T, vector securityVector) *SecurityCodec {
	t.Helper()
	masterKey, err := base64.StdEncoding.DecodeString(vector.MasterKeyB64)
	if err != nil {
		t.Fatalf("decode master key: %v", err)
	}
	salt, err := base64.StdEncoding.DecodeString(vector.SaltB64)
	if err != nil {
		t.Fatalf("decode salt: %v", err)
	}
	algorithm, err := parseSecurityAlgorithm(vector.Algorithm)
	if err != nil {
		t.Fatalf("parse algorithm: %v", err)
	}
	profile := &ResolvedSecurityProfile{
		Name:         vector.Profile,
		Algorithm:    algorithm,
		AADContext:   vector.AADContext,
		ReplayWindow: 4096,
		EncryptKeyID: vector.KeyID,
		Keys: map[string]ResolvedSecurityKey{
			vector.KeyID: {
				KeyID:     vector.KeyID,
				MasterKey: masterKey,
				Salt:      salt,
			},
		},
	}
	codec, err := NewSecurityCodec(SecurityBinding{
		Profile:     profile,
		Route:       vector.Route,
		Binding:     vector.Binding,
		Transport:   vector.Transport,
		Address:     vector.Address,
		MessageType: vector.MessageType,
	})
	if err != nil {
		t.Fatalf("new security codec: %v", err)
	}
	return codec
}
