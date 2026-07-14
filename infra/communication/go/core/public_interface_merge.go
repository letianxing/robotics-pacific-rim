package core

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

type publicInterfaceCatalog struct {
	Topics   map[string]map[string]any
	Services map[string]map[string]any
}

func LoadEffectiveYAMLConfig(configPath string, out any) error {
	mergedData, err := loadEffectiveYAMLData(configPath)
	if err != nil {
		return err
	}
	if err := yaml.Unmarshal(mergedData, out); err != nil {
		return fmt.Errorf("decode merged communication config %q: %w", configPath, err)
	}
	return nil
}

func loadEffectiveBootstrapConfig(configPath string) (BootstrapConfig, error) {
	var cfg BootstrapConfig
	if err := LoadEffectiveYAMLConfig(configPath, &cfg); err != nil {
		return BootstrapConfig{}, err
	}
	return cfg, nil
}

func loadEffectiveYAMLData(configPath string) ([]byte, error) {
	data, err := os.ReadFile(configPath) //nolint:gosec // Service config path is provided by the service entrypoint.
	if err != nil {
		return nil, fmt.Errorf("read communication config %q: %w", configPath, err)
	}

	raw := map[string]any{}
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parse communication config %q: %w", configPath, err)
	}
	if communication, ok := asMap(raw["communication"]); ok {
		raw["communication"] = mergePublicInterfaceRefs(communication, configPath)
	}

	mergedData, err := yaml.Marshal(raw)
	if err != nil {
		return nil, fmt.Errorf("marshal merged communication config %q: %w", configPath, err)
	}
	return mergedData, nil
}

func mergePublicInterfaceRefs(communication map[string]any, configPath string) map[string]any {
	merged := cloneMap(communication)
	topics, _ := asMap(merged["topics"])
	services, _ := asMap(merged["services"])
	if !hasTopicRefs(topics) && !hasServiceRefs(services) {
		return merged
	}

	catalog := loadPublicInterfaceCatalog(configPath)
	if len(catalog.Topics) == 0 && len(catalog.Services) == 0 {
		return merged
	}
	if len(topics) > 0 {
		merged["topics"] = mergeTopicRouteRefs(topics, catalog.Topics)
	}
	if len(services) > 0 {
		merged["services"] = mergeServiceRouteRefs(services, catalog.Services)
	}
	return merged
}

func hasTopicRefs(routes map[string]any) bool {
	for _, raw := range routes {
		route, ok := asMap(raw)
		if ok && strings.TrimSpace(asString(route["topic_ref"])) != "" {
			return true
		}
	}
	return false
}

func hasServiceRefs(routes map[string]any) bool {
	for _, raw := range routes {
		route, ok := asMap(raw)
		if ok && strings.TrimSpace(asString(route["service_ref"])) != "" {
			return true
		}
	}
	return false
}

func mergeTopicRouteRefs(routes map[string]any, catalog map[string]map[string]any) map[string]any {
	merged := map[string]any{}
	for name, raw := range routes {
		route, ok := asMap(raw)
		if !ok {
			merged[name] = raw
			continue
		}
		public := catalog[strings.TrimSpace(asString(route["topic_ref"]))]
		if public == nil {
			merged[name] = raw
			continue
		}
		merged[name] = mergePublicRoute(route, public)
	}
	return merged
}

func mergeServiceRouteRefs(routes map[string]any, catalog map[string]map[string]any) map[string]any {
	merged := map[string]any{}
	for name, raw := range routes {
		route, ok := asMap(raw)
		if !ok {
			merged[name] = raw
			continue
		}
		public := catalog[strings.TrimSpace(asString(route["service_ref"]))]
		if public == nil {
			merged[name] = raw
			continue
		}
		merged[name] = mergePublicRoute(route, public)
	}
	return merged
}

func mergePublicRoute(route map[string]any, public map[string]any) map[string]any {
	merged := cloneMap(public)
	for key, value := range route {
		if key != "bindings" && key != "routes" {
			merged[key] = cloneValue(value)
		}
	}
	if direction := strings.TrimSpace(asString(route["direction"])); direction != "" {
		merged["role"] = direction
	}

	rawBindings := asSlice(route["bindings"])
	if len(rawBindings) == 0 {
		rawBindings = asSlice(route["routes"])
	}
	publicBindings := asSlice(public["bindings"])
	if len(rawBindings) > 0 {
		merged["bindings"] = mergePublicBindings(rawBindings, publicBindings, route)
	} else if len(publicBindings) > 0 {
		bindings := make([]any, 0, len(publicBindings))
		for _, rawBinding := range publicBindings {
			binding, ok := asMap(rawBinding)
			if !ok {
				continue
			}
			item := cloneMap(binding)
			applyRouteBindingOverrides(item, route)
			bindings = append(bindings, item)
		}
		merged["bindings"] = bindings
	}
	return merged
}

func mergePublicBindings(rawBindings []any, publicBindings []any, route map[string]any) []any {
	bindings := make([]any, 0, len(rawBindings))
	for _, rawBinding := range rawBindings {
		binding, ok := asMap(rawBinding)
		if !ok {
			continue
		}
		item := map[string]any{}
		if index, base := findMatchingPublicBinding(binding, publicBindings); base != nil {
			item = cloneMap(base)
			_ = index
		}
		for key, value := range binding {
			item[key] = cloneValue(value)
		}
		applyRouteBindingOverrides(item, route)
		bindings = append(bindings, item)
	}
	return bindings
}

func findMatchingPublicBinding(binding map[string]any, publicBindings []any) (int, map[string]any) {
	for index, raw := range publicBindings {
		candidate, ok := asMap(raw)
		if ok && sameBinding(candidate, binding) {
			return index, candidate
		}
	}
	return -1, nil
}

func applyRouteBindingOverrides(binding map[string]any, route map[string]any) {
	for _, key := range []string{"queue_group", "queue_size", "enabled", "qos", "metadata"} {
		if binding[key] == nil && route[key] != nil {
			binding[key] = cloneValue(route[key])
		}
	}
}

func sameBinding(left map[string]any, right map[string]any) bool {
	leftTransport := normalizeToken(asString(left["transport"]))
	rightTransport := normalizeToken(asString(right["transport"]))
	if leftTransport != "" && leftTransport == rightTransport {
		return true
	}
	leftAddress := bindingAddress(left)
	return leftAddress != "" && leftAddress == bindingAddress(right)
}

func bindingAddress(binding map[string]any) string {
	return strings.TrimSpace(firstNonEmpty(
		asString(binding["topic"]),
		asString(binding["subject"]),
		asString(binding["service"]),
		asString(binding["address"]),
	))
}

func publicBindingRefs(route map[string]any, serviceRoute bool) []string {
	refs := []string{}
	add := func(value string) {
		value = strings.TrimSpace(value)
		if value == "" {
			return
		}
		for _, existing := range refs {
			if existing == value {
				return
			}
		}
		refs = append(refs, value)
	}
	if serviceRoute {
		add(asString(route["service"]))
		add(asString(route["ros_service"]))
	} else {
		add(asString(route["topic"]))
		add(asString(route["ros_topic"]))
	}
	add(asString(route["address"]))
	if addresses, ok := asMap(route["addresses"]); ok {
		for _, value := range addresses {
			add(asString(value))
		}
	}
	for _, rawBinding := range asSlice(route["bindings"]) {
		binding, ok := asMap(rawBinding)
		if !ok {
			continue
		}
		if serviceRoute {
			add(asString(binding["service"]))
			add(asString(binding["ros_service"]))
		} else {
			add(asString(binding["topic"]))
			add(asString(binding["ros_topic"]))
		}
		add(asString(binding["address"]))
	}
	return refs
}

func addPublicRouteAlias(catalog map[string]map[string]any, ref string, route map[string]any) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return
	}
	if _, exists := catalog[ref]; !exists {
		catalog[ref] = route
	}
}

func loadPublicInterfaceCatalog(configPath string) publicInterfaceCatalog {
	root := resolveWorkspaceRoot(configPath)
	if root == "" {
		return publicInterfaceCatalog{Topics: map[string]map[string]any{}, Services: map[string]map[string]any{}}
	}
	idlRoot := filepath.Join(root, "pkg", "idl")
	catalog := publicInterfaceCatalog{
		Topics:   map[string]map[string]any{},
		Services: map[string]map[string]any{},
	}
	for _, pattern := range []string{
		filepath.Join(idlRoot, "*", "topics", "*.yml"),
		filepath.Join(idlRoot, "*", "topics", "*.yaml"),
		filepath.Join(idlRoot, "*", "public", "*.yml"),
		filepath.Join(idlRoot, "*", "public", "*.yaml"),
	} {
		files, _ := filepath.Glob(pattern)
		for _, file := range files {
			addPublicManifestEntries(idlRoot, file, &catalog)
		}
	}
	return catalog
}

func addPublicManifestEntries(idlRoot string, manifest string, catalog *publicInterfaceCatalog) {
	raw, ok := loadYAMLMap(manifest)
	if !ok {
		return
	}
	relative, err := filepath.Rel(idlRoot, manifest)
	if err != nil {
		return
	}
	parts := strings.Split(filepath.ToSlash(relative), "/")
	if len(parts) == 0 || parts[0] == "" {
		return
	}
	idlService := parts[0]

	if topicEntries, ok := asMap(raw["topics"]); ok {
		for name, rawRoute := range topicEntries {
			route, ok := asMap(rawRoute)
			if !ok {
				continue
			}
			item := cloneMap(route)
			item["topic_ref"] = idlService + "." + name
			normalizePublicTopicItem(item)
			catalog.Topics[idlService+"."+name] = item
			for _, ref := range publicBindingRefs(item, false) {
				addPublicRouteAlias(catalog.Topics, ref, item)
			}
		}
	} else if _, hasServices := asMap(raw["services"]); !hasServices {
		name := strings.TrimSuffix(filepath.Base(manifest), filepath.Ext(manifest))
		name = strings.TrimSuffix(strings.TrimSuffix(name, ".topic"), ".service")
		if routeName := strings.TrimSpace(asString(raw["name"])); routeName != "" {
			name = routeName
		}
		item := cloneMap(raw)
		item["topic_ref"] = idlService + "." + name
		normalizePublicTopicItem(item)
		catalog.Topics[idlService+"."+name] = item
		for _, ref := range publicBindingRefs(item, false) {
			addPublicRouteAlias(catalog.Topics, ref, item)
		}
	}

	if serviceEntries, ok := asMap(raw["services"]); ok {
		for name, rawRoute := range serviceEntries {
			route, ok := asMap(rawRoute)
			if !ok {
				continue
			}
			item := cloneMap(route)
			item["service_ref"] = idlService + "." + name
			normalizePublicServiceItem(item)
			catalog.Services[idlService+"."+name] = item
			for _, ref := range publicBindingRefs(item, true) {
				addPublicRouteAlias(catalog.Services, ref, item)
			}
		}
	}
}

func normalizePublicTopicItem(item map[string]any) {
	if payload, ok := asMap(item["payload"]); ok {
		if item["message_type"] == nil && payload["type"] != nil && normalizeToken(asString(payload["format"])) == "ros2_msg" {
			item["message_type"] = asString(payload["type"])
		}
		return
	}
	data := firstNonEmpty(asString(item["data"]), asString(item["data_format"]))
	typ := asString(item["type"])
	if data == "" && typ == "" {
		return
	}
	payload := map[string]any{
		"format": topicPayloadFormat(data),
		"type":   typ,
	}
	item["payload"] = payload
	if item["message_type"] == nil && payload["format"] == "ros2_msg" && typ != "" {
		item["message_type"] = typ
	}
}

func normalizePublicServiceItem(item map[string]any) {
	if contract, ok := asMap(item["contract"]); ok {
		if item["service_type"] == nil && contract["type"] != nil && normalizeToken(asString(contract["format"])) == "ros2_srv" {
			item["service_type"] = asString(contract["type"])
		}
		return
	}
	data := firstNonEmpty(asString(item["data"]), asString(item["data_format"]))
	typ := asString(item["type"])
	if data == "" && typ == "" {
		return
	}
	contract := map[string]any{
		"format": serviceContractFormat(data),
		"type":   typ,
	}
	if responseType := firstNonEmpty(asString(item["response_type"]), asString(item["responseType"])); responseType != "" {
		contract["response_type"] = responseType
	}
	item["contract"] = contract
	if item["service_type"] == nil && contract["format"] == "ros2_srv" && typ != "" {
		item["service_type"] = typ
	}
}

func loadYAMLMap(path string) (map[string]any, bool) {
	data, err := os.ReadFile(path) //nolint:gosec // Repository-local manifest path under workspace.
	if err != nil {
		return nil, false
	}
	raw := map[string]any{}
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, false
	}
	return raw, true
}

func resolveWorkspaceRoot(configPath string) string {
	resolved, err := filepath.Abs(configPath)
	if err != nil {
		return ""
	}
	for path := filepath.Dir(resolved); path != "" && path != filepath.Dir(path); path = filepath.Dir(path) {
		if info, err := os.Stat(filepath.Join(path, "pkg", "idl")); err == nil && info.IsDir() {
			return path
		}
	}
	return ""
}

func normalizeToken(value string) string {
	return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(value)), "-", "_")
}

func asMap(value any) (map[string]any, bool) {
	typed, ok := value.(map[string]any)
	return typed, ok
}

func asSlice(value any) []any {
	typed, ok := value.([]any)
	if !ok {
		return nil
	}
	return typed
}

func asString(value any) string {
	typed, _ := value.(string)
	return typed
}

func cloneMap(input map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range input {
		out[key] = cloneValue(value)
	}
	return out
}

func cloneValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return cloneMap(typed)
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, cloneValue(item))
		}
		return out
	default:
		return typed
	}
}
