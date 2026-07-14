package core

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"strings"

	communication "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"
)

const (
	SecurityOptionProfile   = "security.profile"
	SecurityMetadataProfile = "security.profile"
	SecurityProfileNone     = "none"
)

type SecuritySettings struct {
	RequireExplicitProfile bool                             `json:"require_explicit_profile,omitempty" yaml:"require_explicit_profile,omitempty"`
	Profiles               map[string]SecurityProfileConfig `json:"profiles,omitempty" yaml:"profiles,omitempty"`
}

type SecurityProfileConfig struct {
	Enabled      *bool               `json:"enabled,omitempty" yaml:"enabled,omitempty"`
	Algorithm    string              `json:"algorithm,omitempty" yaml:"algorithm,omitempty"`
	KeyID        string              `json:"key_id,omitempty" yaml:"key_id,omitempty"`
	EncryptKeyID string              `json:"encrypt_key_id,omitempty" yaml:"encrypt_key_id,omitempty"`
	KeyEnv       string              `json:"key_env,omitempty" yaml:"key_env,omitempty"`
	SaltEnv      string              `json:"salt_env,omitempty" yaml:"salt_env,omitempty"`
	AADContext   string              `json:"aad_context,omitempty" yaml:"aad_context,omitempty"`
	ReplayWindow uint64              `json:"replay_window,omitempty" yaml:"replay_window,omitempty"`
	FailOpen     bool                `json:"fail_open,omitempty" yaml:"fail_open,omitempty"`
	Keys         []SecurityKeyConfig `json:"keys,omitempty" yaml:"keys,omitempty"`
}

type SecurityKeyConfig struct {
	KeyID       string `json:"key_id,omitempty" yaml:"key_id,omitempty"`
	KeyEnv      string `json:"key_env,omitempty" yaml:"key_env,omitempty"`
	SaltEnv     string `json:"salt_env,omitempty" yaml:"salt_env,omitempty"`
	DecryptOnly bool   `json:"decrypt_only,omitempty" yaml:"decrypt_only,omitempty"`
}

type ResolvedSecurityProfile struct {
	Name         string
	Algorithm    securityAlgorithm
	AADContext   string
	ReplayWindow uint64
	EncryptKeyID string
	FailOpen     bool
	Keys         map[string]ResolvedSecurityKey
}

type ResolvedSecurityKey struct {
	KeyID       string
	MasterKey   []byte
	Salt        []byte
	DecryptOnly bool
}

type SecurityRuntime struct {
	RequireExplicitProfile bool
	profiles               map[string]*ResolvedSecurityProfile
}

type SecurityBinding struct {
	Profile     *ResolvedSecurityProfile
	Route       string
	Binding     string
	Transport   string
	Address     string
	MessageType string
}

func NewSecurityRuntime(settings SecuritySettings) (*SecurityRuntime, error) {
	runtime := &SecurityRuntime{
		RequireExplicitProfile: settings.RequireExplicitProfile,
		profiles:               map[string]*ResolvedSecurityProfile{},
	}
	for name, config := range settings.Profiles {
		if !securityProfileEnabled(config) {
			continue
		}
		profile, err := resolveSecurityProfile(strings.TrimSpace(name), config)
		if err != nil {
			return nil, err
		}
		runtime.profiles[profile.Name] = profile
	}
	return runtime, nil
}

func (r *SecurityRuntime) ResolveBinding(
	busName string,
	busConfig BusConfig,
	endpoint communication.Endpoint,
) (*SecurityBinding, error) {
	if r == nil {
		return nil, nil
	}
	profileName, explicit := endpointSecurityProfile(endpoint)
	if profileName == "" {
		profileName = busSecurityProfile(busConfig)
	}
	normalized := normalizeSecurityProfile(profileName)
	if normalized == SecurityProfileNone {
		return nil, nil
	}
	if normalized == "" {
		if r.RequireExplicitProfile && busConfig.Transport == communication.TransportNATS {
			return nil, fmt.Errorf("security_profile is required for route endpoint %q on middleware %q", endpoint.Address, busName)
		}
		return nil, nil
	}
	if !explicit && r.RequireExplicitProfile && busConfig.Transport == communication.TransportNATS {
		return nil, fmt.Errorf("security_profile must be explicit for route endpoint %q on middleware %q", endpoint.Address, busName)
	}
	profile := r.profiles[normalized]
	if profile == nil {
		return nil, fmt.Errorf("security profile %q is not configured or is disabled", normalized)
	}
	metadata := endpoint.Metadata
	route := strings.TrimSpace(metadata["logical_route"])
	if route == "" {
		route = strings.TrimSpace(metadata["source_name"])
	}
	if route == "" {
		route = endpoint.Address
	}
	binding := strings.TrimSpace(metadata["binding_name"])
	if binding == "" {
		binding = busName
	}
	return &SecurityBinding{
		Profile:     profile,
		Route:       route,
		Binding:     binding,
		Transport:   string(busConfig.Transport),
		Address:     endpoint.Address,
		MessageType: endpoint.MessageType,
	}, nil
}

func securityProfileEnabled(config SecurityProfileConfig) bool {
	if config.Enabled == nil {
		return true
	}
	return *config.Enabled
}

func resolveSecurityProfile(name string, config SecurityProfileConfig) (*ResolvedSecurityProfile, error) {
	if name == "" {
		return nil, fmt.Errorf("security profile name is required")
	}
	algorithm, err := parseSecurityAlgorithm(config.Algorithm)
	if err != nil {
		return nil, fmt.Errorf("security profile %q: %w", name, err)
	}
	keys := config.Keys
	if len(keys) == 0 {
		keys = []SecurityKeyConfig{{
			KeyID:   firstNonEmpty(config.KeyID, config.EncryptKeyID),
			KeyEnv:  config.KeyEnv,
			SaltEnv: config.SaltEnv,
		}}
	}
	resolvedKeys := make(map[string]ResolvedSecurityKey, len(keys))
	for _, keyConfig := range keys {
		keyID := strings.TrimSpace(keyConfig.KeyID)
		if keyID == "" {
			return nil, fmt.Errorf("security profile %q: key_id is required", name)
		}
		masterKey, err := secretFromEnv(keyConfig.KeyEnv)
		if err != nil {
			return nil, fmt.Errorf("security profile %q key %q: %w", name, keyID, err)
		}
		salt, err := optionalSecretFromEnv(keyConfig.SaltEnv)
		if err != nil {
			return nil, fmt.Errorf("security profile %q key %q: %w", name, keyID, err)
		}
		resolvedKeys[keyID] = ResolvedSecurityKey{
			KeyID:       keyID,
			MasterKey:   masterKey,
			Salt:        salt,
			DecryptOnly: keyConfig.DecryptOnly,
		}
	}
	encryptKeyID := strings.TrimSpace(firstNonEmpty(config.EncryptKeyID, config.KeyID))
	if encryptKeyID == "" {
		return nil, fmt.Errorf("security profile %q: encrypt_key_id or key_id is required", name)
	}
	key := resolvedKeys[encryptKeyID]
	if key.KeyID == "" {
		return nil, fmt.Errorf("security profile %q: encrypt key %q is not configured", name, encryptKeyID)
	}
	if key.DecryptOnly {
		return nil, fmt.Errorf("security profile %q: encrypt key %q is decrypt_only", name, encryptKeyID)
	}
	replayWindow := config.ReplayWindow
	if replayWindow == 0 {
		replayWindow = 4096
	}
	return &ResolvedSecurityProfile{
		Name:         name,
		Algorithm:    algorithm,
		AADContext:   strings.TrimSpace(config.AADContext),
		ReplayWindow: replayWindow,
		EncryptKeyID: encryptKeyID,
		FailOpen:     config.FailOpen,
		Keys:         resolvedKeys,
	}, nil
}

func endpointSecurityProfile(endpoint communication.Endpoint) (string, bool) {
	if endpoint.Metadata == nil {
		return "", false
	}
	value, ok := endpoint.Metadata[SecurityMetadataProfile]
	if !ok {
		value, ok = endpoint.Metadata["security_profile"]
	}
	return value, ok
}

func busSecurityProfile(config BusConfig) string {
	if config.Options == nil {
		return ""
	}
	for _, key := range []string{SecurityOptionProfile, "security_profile"} {
		if value, ok := config.Options[key]; ok {
			return fmt.Sprint(value)
		}
	}
	return ""
}

func normalizeSecurityProfile(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	switch normalized {
	case "", "inherit":
		return ""
	case "none", "disabled", "disable", "off", "plaintext", "plain":
		return SecurityProfileNone
	default:
		return strings.TrimSpace(value)
	}
}

func secretFromEnv(envName string) ([]byte, error) {
	name := strings.TrimSpace(envName)
	if name == "" {
		return nil, fmt.Errorf("key_env is required")
	}
	value, ok := os.LookupEnv(name)
	if !ok || strings.TrimSpace(value) == "" {
		return nil, fmt.Errorf("environment variable %s is empty", name)
	}
	return decodeSecret(value), nil
}

func optionalSecretFromEnv(envName string) ([]byte, error) {
	name := strings.TrimSpace(envName)
	if name == "" {
		return nil, nil
	}
	value, ok := os.LookupEnv(name)
	if !ok || strings.TrimSpace(value) == "" {
		return nil, fmt.Errorf("environment variable %s is empty", name)
	}
	return decodeSecret(value), nil
}

func decodeSecret(value string) []byte {
	text := strings.TrimSpace(value)
	if decoded, err := base64.StdEncoding.DecodeString(text); err == nil {
		return decoded
	}
	if decoded, err := base64.RawStdEncoding.DecodeString(text); err == nil {
		return decoded
	}
	if decoded, err := hex.DecodeString(text); err == nil {
		return decoded
	}
	return []byte(text)
}

func randomUint64() (uint64, error) {
	var data [8]byte
	if _, err := rand.Read(data[:]); err != nil {
		return 0, err
	}
	var value uint64
	for _, item := range data {
		value = (value << 8) | uint64(item)
	}
	if value == 0 {
		value = 1
	}
	return value, nil
}
