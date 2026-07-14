package core

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	communication "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"
)

type ServiceCommunicationConfig struct {
	Middleware    map[string]MiddlewareConfig   `json:"middleware" yaml:"middleware"`
	Topics        map[string]TopicRouteConfig   `json:"topics" yaml:"topics"`
	TopicRoutes   map[string]TopicRouteConfig   `json:"topic_routes" yaml:"topic_routes"`
	Services      map[string]ServiceRouteConfig `json:"services" yaml:"services"`
	ServiceRoutes map[string]ServiceRouteConfig `json:"service_routes" yaml:"service_routes"`
	Security      SecuritySettings              `json:"security,omitempty" yaml:"security,omitempty"`
}

type MiddlewareConfig struct {
	Enabled              *bool          `json:"enabled,omitempty" yaml:"enabled,omitempty"`
	Transport            string         `json:"transport" yaml:"transport"`
	Name                 string         `json:"name,omitempty" yaml:"name,omitempty"`
	Options              map[string]any `json:"options,omitempty" yaml:"options,omitempty"`
	ServerURL            string         `json:"server_url,omitempty" yaml:"server_url,omitempty"`
	DomainID             int            `json:"domain_id,omitempty" yaml:"domain_id,omitempty"`
	ROSDomainID          int            `json:"ros_domain_id,omitempty" yaml:"ros_domain_id,omitempty"`
	ParticipantName      string         `json:"participant_name,omitempty" yaml:"participant_name,omitempty"`
	ConfigURI            string         `json:"config_uri,omitempty" yaml:"config_uri,omitempty"`
	TypeName             string         `json:"type_name,omitempty" yaml:"type_name,omitempty"`
	Mode                 string         `json:"mode,omitempty" yaml:"mode,omitempty"`
	Implementation       string         `json:"implementation,omitempty" yaml:"implementation,omitempty"`
	RMWImplementation    string         `json:"rmw_implementation,omitempty" yaml:"rmw_implementation,omitempty"`
	Bridge               map[string]any `json:"bridge,omitempty" yaml:"bridge,omitempty"`
	ConnectTimeoutMS     int            `json:"connect_timeout_ms,omitempty" yaml:"connect_timeout_ms,omitempty"`
	ReconnectWaitMS      int            `json:"reconnect_wait_ms,omitempty" yaml:"reconnect_wait_ms,omitempty"`
	MaxReconnectAttempts int            `json:"max_reconnect_attempts,omitempty" yaml:"max_reconnect_attempts,omitempty"`
	QoS                  map[string]any `json:"qos,omitempty" yaml:"qos,omitempty"`
	SecurityProfile      string         `json:"security_profile,omitempty" yaml:"security_profile,omitempty"`
}

type TopicRouteConfig struct {
	Enabled         *bool              `json:"enabled,omitempty" yaml:"enabled,omitempty"`
	Name            string             `json:"name,omitempty" yaml:"name,omitempty"`
	Data            string             `json:"data,omitempty" yaml:"data,omitempty"`
	DataFormat      string             `json:"data_format,omitempty" yaml:"data_format,omitempty"`
	Type            string             `json:"type,omitempty" yaml:"type,omitempty"`
	Transport       string             `json:"transport" yaml:"transport"`
	Middleware      string             `json:"middleware,omitempty" yaml:"middleware,omitempty"`
	Middlewares     []string           `json:"middlewares,omitempty" yaml:"middlewares,omitempty"`
	Adapter         string             `json:"adapter,omitempty" yaml:"adapter,omitempty"`
	Direction       string             `json:"direction,omitempty" yaml:"direction,omitempty"`
	Subject         string             `json:"subject,omitempty" yaml:"subject,omitempty"`
	NATSSubject     string             `json:"nats_subject,omitempty" yaml:"nats_subject,omitempty"`
	Topic           string             `json:"topic,omitempty" yaml:"topic,omitempty"`
	DDSTopic        string             `json:"dds_topic,omitempty" yaml:"dds_topic,omitempty"`
	Address         string             `json:"address,omitempty" yaml:"address,omitempty"`
	Addresses       map[string]string  `json:"addresses,omitempty" yaml:"addresses,omitempty"`
	MessageType     string             `json:"message_type,omitempty" yaml:"message_type,omitempty"`
	MsgType         string             `json:"msg_type,omitempty" yaml:"msg_type,omitempty"`
	ROSMessageType  string             `json:"ros_message_type,omitempty" yaml:"ros_message_type,omitempty"`
	Payload         PayloadConfig      `json:"payload,omitempty" yaml:"payload,omitempty"`
	QueueSize       int                `json:"queue_size,omitempty" yaml:"queue_size,omitempty"`
	QueueGroup      string             `json:"queue_group,omitempty" yaml:"queue_group,omitempty"`
	Metadata        map[string]string  `json:"metadata,omitempty" yaml:"metadata,omitempty"`
	QoS             map[string]any     `json:"qos,omitempty" yaml:"qos,omitempty"`
	SecurityProfile string             `json:"security_profile,omitempty" yaml:"security_profile,omitempty"`
	Bindings        []TopicRouteConfig `json:"bindings,omitempty" yaml:"bindings,omitempty"`
	Routes          []TopicRouteConfig `json:"routes,omitempty" yaml:"routes,omitempty"`
}

type PayloadConfig struct {
	Format string `json:"format,omitempty" yaml:"format,omitempty"`
	Type   string `json:"type,omitempty" yaml:"type,omitempty"`
}

type ServiceRouteConfig struct {
	Enabled         *bool                `json:"enabled,omitempty" yaml:"enabled,omitempty"`
	Name            string               `json:"name,omitempty" yaml:"name,omitempty"`
	Data            string               `json:"data,omitempty" yaml:"data,omitempty"`
	DataFormat      string               `json:"data_format,omitempty" yaml:"data_format,omitempty"`
	Type            string               `json:"type,omitempty" yaml:"type,omitempty"`
	Transport       string               `json:"transport" yaml:"transport"`
	Middleware      string               `json:"middleware,omitempty" yaml:"middleware,omitempty"`
	Middlewares     []string             `json:"middlewares,omitempty" yaml:"middlewares,omitempty"`
	Adapter         string               `json:"adapter,omitempty" yaml:"adapter,omitempty"`
	Direction       string               `json:"direction,omitempty" yaml:"direction,omitempty"`
	Role            string               `json:"role,omitempty" yaml:"role,omitempty"`
	Subject         string               `json:"subject,omitempty" yaml:"subject,omitempty"`
	NATSSubject     string               `json:"nats_subject,omitempty" yaml:"nats_subject,omitempty"`
	Service         string               `json:"service,omitempty" yaml:"service,omitempty"`
	Request         string               `json:"request,omitempty" yaml:"request,omitempty"`
	Response        string               `json:"response,omitempty" yaml:"response,omitempty"`
	RequestChannel  string               `json:"request_channel,omitempty" yaml:"request_channel,omitempty"`
	ResponseChannel string               `json:"response_channel,omitempty" yaml:"response_channel,omitempty"`
	Standard        string               `json:"standard,omitempty" yaml:"standard,omitempty"`
	Address         string               `json:"address,omitempty" yaml:"address,omitempty"`
	Addresses       map[string]string    `json:"addresses,omitempty" yaml:"addresses,omitempty"`
	MessageType     string               `json:"message_type,omitempty" yaml:"message_type,omitempty"`
	ServiceType     string               `json:"service_type,omitempty" yaml:"service_type,omitempty"`
	ROSServiceType  string               `json:"ros_service_type,omitempty" yaml:"ros_service_type,omitempty"`
	Contract        PayloadConfig        `json:"contract,omitempty" yaml:"contract,omitempty"`
	Timeout         time.Duration        `json:"timeout,omitempty" yaml:"timeout,omitempty"`
	TimeoutMS       int                  `json:"timeout_ms,omitempty" yaml:"timeout_ms,omitempty"`
	QueueGroup      string               `json:"queue_group,omitempty" yaml:"queue_group,omitempty"`
	QoS             map[string]any       `json:"qos,omitempty" yaml:"qos,omitempty"`
	Metadata        map[string]string    `json:"metadata,omitempty" yaml:"metadata,omitempty"`
	SecurityProfile string               `json:"security_profile,omitempty" yaml:"security_profile,omitempty"`
	Bindings        []ServiceRouteConfig `json:"bindings,omitempty" yaml:"bindings,omitempty"`
	Routes          []ServiceRouteConfig `json:"routes,omitempty" yaml:"routes,omitempty"`
}

func (c ServiceCommunicationConfig) Build(serviceName string) (
	map[string]BusConfig,
	[]communication.PubSubRoute,
	[]communication.RPCRoute,
	error,
) {
	buses, err := c.middlewareConfigs()
	if err != nil {
		return nil, nil, nil, err
	}
	pubsubRoutes, err := c.pubsubRoutes(serviceName)
	if err != nil {
		return nil, nil, nil, err
	}
	rpcRoutes, err := c.rpcRoutes(serviceName)
	if err != nil {
		return nil, nil, nil, err
	}
	return buses, pubsubRoutes, rpcRoutes, nil
}

func (c ServiceCommunicationConfig) middlewareConfigs() (map[string]BusConfig, error) {
	configs := make(map[string]BusConfig, len(c.Middleware))
	for name, item := range c.Middleware {
		if !enabled(item.Enabled) {
			continue
		}
		transportName := defaultString(item.Transport, name)
		transport, err := normalizeServiceTransport(transportName)
		if err != nil {
			return nil, err
		}
		options := middlewareOptions(item)
		applyMiddlewareTransportDefaults(options, transportName)
		configs[name] = BusConfig{Transport: transport, Name: item.Name, Options: options}
	}
	for _, ref := range c.referencedDefaultMiddleware() {
		if _, ok := configs[ref.Name]; ok {
			continue
		}
		configs[ref.Name] = BusConfig{Transport: ref.Transport, Name: ref.Name, Options: ref.Options}
	}
	return configs, nil
}

func (c ServiceCommunicationConfig) pubsubRoutes(serviceName string) ([]communication.PubSubRoute, error) {
	all, err := expandTopicRoutes(expandMiddlewareTopics(mergeTopicRoutes(c.Topics, c.TopicRoutes)))
	if err != nil {
		return nil, err
	}
	routes := make([]communication.PubSubRoute, 0, len(all))
	for name, item := range all {
		if !enabled(item.Enabled) {
			continue
		}
		transport, err := normalizeServiceTransport(defaultString(item.Transport, "nats_topic"))
		if err != nil {
			return nil, err
		}
		if err := validateTopicCompatibility(name, item, transport); err != nil {
			return nil, err
		}
		metadata := routeMetadata(item.Metadata, item.Middleware, name)
		putSecurityMetadata(metadata, item.SecurityProfile)
		putTopicMetadata(metadata, item)
		putQoSMetadata(metadata, item.QoS)
		if _, ok := metadata["qos.depth"]; !ok && queueSize(item.QueueSize) > 0 {
			metadata["qos.depth"] = strconv.Itoa(queueSize(item.QueueSize))
		}
		channelType := endpointType(transport, metadata, payloadType(item.Payload), item.MessageType, item.MsgType)
		channel := endpoint(transport, topicAddress(name, item, transport), metadata, channelType)
		local := communication.Endpoint{Transport: communication.TransportInProcess, Address: serviceName}
		publisher, subscriber := channel, local
		if strings.EqualFold(item.Direction, "subscribe") || strings.EqualFold(item.Direction, "in") {
			publisher, subscriber = local, channel
		}
		routes = append(routes, communication.PubSubRoute{Name: name, Publisher: publisher, Subscriber: subscriber, QueueSize: queueSize(item.QueueSize), Enabled: true})
	}
	return routes, nil
}

func (c ServiceCommunicationConfig) rpcRoutes(serviceName string) ([]communication.RPCRoute, error) {
	all, err := expandServiceRoutes(expandMiddlewareServices(mergeServiceRoutes(c.Services, c.ServiceRoutes)))
	if err != nil {
		return nil, err
	}
	routes := make([]communication.RPCRoute, 0, len(all))
	for name, item := range all {
		if !enabled(item.Enabled) {
			continue
		}
		transport, err := normalizeServiceTransport(defaultString(item.Transport, "nats_rpc"))
		if err != nil {
			return nil, err
		}
		if err := validateServiceCompatibility(name, item, transport); err != nil {
			return nil, err
		}
		metadata := routeMetadata(item.Metadata, item.Middleware, name)
		putSecurityMetadata(metadata, item.SecurityProfile)
		putServiceMetadata(metadata, item, transport)
		putQoSMetadata(metadata, item.QoS)
		client := communication.Endpoint{Transport: transport, Address: serviceName, Metadata: metadata}
		serverType := endpointType(transport, metadata, contractType(item.Contract), item.MessageType, item.ServiceType)
		server := endpoint(transport, serviceAddress(name, item, transport), metadata, serverType)
		routes = append(routes, communication.RPCRoute{Name: routeName(name), Client: client, Server: server, TimeoutMS: timeoutMS(item), Enabled: true})
	}
	return routes, nil
}

func normalizeServiceTransport(value string) (communication.TransportKind, error) {
	normalized := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(value)), "-", "_")
	switch normalized {
	case "nats", "nats_rpc", "nats_topic":
		return communication.TransportNATS, nil
	case "dds", "cyclonedds", "cyclone_dds", "dds_topic", "cyclonedds_topic", "dds_rpc", "cyclonedds_rpc":
		return communication.TransportCycloneDDS, nil
	case "fastdds", "fast_dds", "fastrtps", "fast_rtps", "fastdds_topic", "fastdds_rpc":
		return communication.TransportFastDDS, nil
	case "ros2_topic", "ros2_service":
		return communication.TransportROS2, nil
	default:
		return NormalizeKind(normalized)
	}
}

type defaultMiddlewareRef struct {
	Name      string
	Transport communication.TransportKind
	Options   map[string]any
}

func (c ServiceCommunicationConfig) referencedDefaultMiddleware() []defaultMiddlewareRef {
	seen := map[string]defaultMiddlewareRef{}
	addTopic := func(route TopicRouteConfig) {
		if !isHighLevelTopicRoute(route) {
			return
		}
		name := route.Middleware
		if name == "" {
			return
		}
		data := routeDataFormat(route.Data, route.DataFormat, route.Payload.Format)
		routeType := firstNonEmpty(route.Payload.Type, route.Type, route.MessageType, route.MsgType, route.ROSMessageType)
		plan, err := topicExecutionPlan(name, topicPayloadFormatFor(data, routeType))
		if err != nil {
			return
		}
		if plan.Transport != "" {
			seen[plan.RuntimeMiddlewareName()] = defaultMiddlewareRef{
				Name:      plan.RuntimeMiddlewareName(),
				Transport: plan.Transport,
				Options:   planOptions(plan, c.Middleware[plan.MiddlewareName]),
			}
		}
	}
	addService := func(route ServiceRouteConfig) {
		if !isHighLevelServiceRoute(route) {
			return
		}
		name := route.Middleware
		if name == "" {
			return
		}
		data := routeDataFormat(route.Data, route.DataFormat, route.Contract.Format)
		routeType := firstNonEmpty(route.Contract.Type, route.Type, route.ServiceType, route.MessageType, route.ROSServiceType)
		plan, err := serviceExecutionPlan(name, serviceContractFormatFor(data, routeType))
		if err != nil {
			return
		}
		if plan.Transport != "" {
			seen[plan.RuntimeMiddlewareName()] = defaultMiddlewareRef{
				Name:      plan.RuntimeMiddlewareName(),
				Transport: plan.Transport,
				Options:   planOptions(plan, c.Middleware[plan.MiddlewareName]),
			}
		}
	}
	for _, route := range expandMiddlewareTopics(c.Topics) {
		addTopic(route)
		for _, binding := range topicBindings(route) {
			merged := mergeTopicRoute(route, binding)
			addTopic(merged)
		}
	}
	for _, route := range expandMiddlewareTopics(c.TopicRoutes) {
		addTopic(route)
		for _, binding := range topicBindings(route) {
			merged := mergeTopicRoute(route, binding)
			addTopic(merged)
		}
	}
	for _, route := range expandMiddlewareServices(c.Services) {
		addService(route)
		for _, binding := range serviceBindings(route) {
			merged := mergeServiceRoute(route, binding)
			addService(merged)
		}
	}
	for _, route := range expandMiddlewareServices(c.ServiceRoutes) {
		addService(route)
		for _, binding := range serviceBindings(route) {
			merged := mergeServiceRoute(route, binding)
			addService(merged)
		}
	}
	refs := make([]defaultMiddlewareRef, 0, len(seen))
	for _, ref := range seen {
		refs = append(refs, ref)
	}
	return refs
}

func expandMiddlewareTopics(routes map[string]TopicRouteConfig) map[string]TopicRouteConfig {
	expanded := map[string]TopicRouteConfig{}
	for name, route := range routes {
		if len(route.Middlewares) == 0 {
			expanded[name] = route
			continue
		}
		for _, middleware := range route.Middlewares {
			item := route
			item.Middleware = middleware
			item.Middlewares = nil
			item.Bindings = nil
			item.Routes = nil
			expanded[name+"_"+routeName(middleware)] = item
		}
	}
	return expanded
}

func expandMiddlewareServices(routes map[string]ServiceRouteConfig) map[string]ServiceRouteConfig {
	expanded := map[string]ServiceRouteConfig{}
	for name, route := range routes {
		if len(route.Middlewares) == 0 {
			expanded[name] = route
			continue
		}
		for _, middleware := range route.Middlewares {
			item := route
			item.Middleware = middleware
			item.Middlewares = nil
			item.Bindings = nil
			item.Routes = nil
			expanded[name+"_"+routeName(middleware)] = item
		}
	}
	return expanded
}

func planOptions(plan routeExecutionPlan, base MiddlewareConfig) map[string]any {
	options := mergeOptionsMap(middlewareOptions(base), plan.Options)
	return options
}

type routeExecutionPlan struct {
	Transport       communication.TransportKind
	TransportName   string
	MiddlewareName  string
	RuntimeName     string
	LogicalProtocol string
	Implementation  string
	Options         map[string]any
}

func (p routeExecutionPlan) RuntimeMiddlewareName() string {
	if strings.TrimSpace(p.RuntimeName) != "" {
		return p.RuntimeName
	}
	return p.MiddlewareName
}

func topicExecutionPlan(protocol string, data string) (routeExecutionPlan, error) {
	protocol, err := normalizeRouteMiddlewareProtocol(protocol)
	if err != nil {
		return routeExecutionPlan{}, err
	}
	if protocol == "cyclonedds" {
		if isNativeDDSTopicFormat(topicPayloadFormat(data)) {
			return nativeCycloneDDSPlan("cyclonedds_topic"), nil
		}
		return cycloneDDSRMWPlan("ros2_topic"), nil
	}
	if protocol == "fastdds" {
		if isNativeDDSTopicFormat(topicPayloadFormat(data)) {
			return nativeFastDDSPlan("fastdds_topic"), nil
		}
		return fastDDSRMWPlan("ros2_topic"), nil
	}
	switch protocol {
	case "ros2":
		return routeExecutionPlan{Transport: communication.TransportROS2, TransportName: "ros2_topic", MiddlewareName: "ros2", LogicalProtocol: "ros2"}, nil
	default:
		return routeExecutionPlan{Transport: communication.TransportNATS, TransportName: "nats_topic", MiddlewareName: "nats", LogicalProtocol: "nats"}, nil
	}
}

func serviceExecutionPlan(protocol string, data string) (routeExecutionPlan, error) {
	protocol, err := normalizeRouteMiddlewareProtocol(protocol)
	if err != nil {
		return routeExecutionPlan{}, err
	}
	if protocol == "cyclonedds" {
		if isNativeDDSServiceFormat(serviceContractFormat(data)) {
			return nativeCycloneDDSPlan("cyclonedds_rpc"), nil
		}
		return cycloneDDSRMWPlan("ros2_service"), nil
	}
	if protocol == "fastdds" {
		if isNativeDDSServiceFormat(serviceContractFormat(data)) {
			return nativeFastDDSPlan("fastdds_rpc"), nil
		}
		return fastDDSRMWPlan("ros2_service"), nil
	}
	switch protocol {
	case "ros2":
		return routeExecutionPlan{Transport: communication.TransportROS2, TransportName: "ros2_service", MiddlewareName: "ros2", LogicalProtocol: "ros2"}, nil
	default:
		return routeExecutionPlan{Transport: communication.TransportNATS, TransportName: "nats_rpc", MiddlewareName: "nats", LogicalProtocol: "nats"}, nil
	}
}

func normalizeRouteMiddlewareProtocol(value string) (string, error) {
	normalized := normalizeToken(value)
	switch normalized {
	case "nats", "nats_topic", "nats_rpc":
		return "nats", nil
	case "cyclonedds", "cyclone_dds":
		return "cyclonedds", nil
	case "fastdds", "fast_dds", "fastrtps", "fast_rtps":
		return "fastdds", nil
	case "ros2", "ros2_topic", "ros2_service":
		return "ros2", nil
	case "":
		return "", fmt.Errorf("high-level route middleware is required; use nats, cyclonedds, fastdds, or ros2")
	default:
		return "", fmt.Errorf("unsupported high-level route middleware %q; use nats, cyclonedds, fastdds, or ros2", value)
	}
}

func cycloneDDSRMWPlan(transportName string) routeExecutionPlan {
	return routeExecutionPlan{
		Transport:       communication.TransportROS2,
		TransportName:   transportName,
		MiddlewareName:  "cyclonedds",
		RuntimeName:     "cyclonedds__rmw",
		LogicalProtocol: "cyclonedds",
		Implementation:  "rmw_cyclonedds",
		Options: map[string]any{
			"middleware.family":  "cyclonedds",
			"implementation":     "rmw_cyclonedds",
			"rmw_implementation": "rmw_cyclonedds_cpp",
		},
	}
}

func fastDDSRMWPlan(transportName string) routeExecutionPlan {
	return routeExecutionPlan{
		Transport:       communication.TransportROS2,
		TransportName:   transportName,
		MiddlewareName:  "fastdds",
		RuntimeName:     "fastdds__rmw",
		LogicalProtocol: "fastdds",
		Implementation:  "rmw_fastrtps",
		Options: map[string]any{
			"middleware.family":  "fastdds",
			"implementation":     "rmw_fastrtps",
			"rmw_implementation": "rmw_fastrtps_cpp",
		},
	}
}

func nativeCycloneDDSPlan(transportName string) routeExecutionPlan {
	return routeExecutionPlan{
		Transport:       communication.TransportCycloneDDS,
		TransportName:   transportName,
		MiddlewareName:  "cyclonedds",
		RuntimeName:     "cyclonedds",
		LogicalProtocol: "cyclonedds",
		Implementation:  "native_cyclonedds",
		Options: map[string]any{
			"middleware.family": "cyclonedds",
			"implementation":    "native_cyclonedds",
		},
	}
}

func nativeFastDDSPlan(transportName string) routeExecutionPlan {
	return routeExecutionPlan{
		Transport:       communication.TransportFastDDS,
		TransportName:   transportName,
		MiddlewareName:  "fastdds",
		RuntimeName:     "fastdds",
		LogicalProtocol: "fastdds",
		Implementation:  "native_fastdds",
		Options: map[string]any{
			"middleware.family": "fastdds",
			"implementation":    "native_fastdds",
		},
	}
}

func routeDataFormat(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func topicPayloadFormat(data string) string {
	switch normalizeDataFormat(data) {
	case "proto", "protobuf", "protobuf_message":
		return "protobuf"
	case "msg", "ros2_msg", "rosidl_msg":
		return "ros2_msg"
	case "dds_idl", "omg_idl", "omg_dds_idl", "ddsidl", "omgidl":
		return "dds_idl"
	case "json":
		return "json"
	case "bytes", "raw", "cdr", "cdr_bytes":
		return "bytes"
	default:
		return normalizeDataFormat(data)
	}
}

func inferTopicPayloadFormat(typ string) string {
	if strings.Contains(typ, "/msg/") {
		return "ros2_msg"
	}
	if strings.Contains(typ, "::") {
		return "dds_idl"
	}
	if strings.TrimSpace(typ) != "" {
		return "protobuf"
	}
	return ""
}

func topicPayloadFormatFor(data string, typ string) string {
	if strings.TrimSpace(data) != "" {
		return topicPayloadFormat(data)
	}
	if inferred := inferTopicPayloadFormat(typ); inferred != "" {
		return inferred
	}
	return topicPayloadFormat(data)
}

func serviceContractFormat(data string) string {
	switch normalizeDataFormat(data) {
	case "proto", "protobuf", "protobuf_rpc", "request_reply", "request_response":
		return "protobuf_rpc"
	case "srv", "ros2_srv", "rosidl_srv":
		return "ros2_srv"
	case "dds_idl", "omg_idl", "omg_dds_idl", "ddsidl", "omgidl", "dds_idl_rpc", "omg_idl_rpc", "omg_dds_rpc_idl":
		return "dds_idl_rpc"
	case "json":
		return "json_rpc"
	case "bytes", "raw", "cdr", "cdr_bytes":
		return "bytes_rpc"
	default:
		return normalizeDataFormat(data)
	}
}

func inferServiceContractFormat(typ string) string {
	if strings.Contains(typ, "/srv/") {
		return "ros2_srv"
	}
	if strings.Contains(typ, "::") {
		return "dds_idl_rpc"
	}
	if strings.TrimSpace(typ) != "" {
		return "protobuf_rpc"
	}
	return ""
}

func serviceContractFormatFor(data string, typ string) string {
	if strings.TrimSpace(data) != "" {
		return serviceContractFormat(data)
	}
	if inferred := inferServiceContractFormat(typ); inferred != "" {
		return inferred
	}
	return serviceContractFormat(data)
}

func normalizeDataFormat(value string) string {
	return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(value)), "-", "_")
}

func isNativeDDSTopicFormat(format string) bool {
	switch topicPayloadFormat(format) {
	case "protobuf", "dds_idl":
		return true
	default:
		return false
	}
}

func isNativeDDSServiceFormat(format string) bool {
	switch serviceContractFormat(format) {
	case "protobuf_rpc", "dds_idl_rpc":
		return true
	default:
		return false
	}
}

func isHighLevelTopicRoute(item TopicRouteConfig) bool {
	return firstNonEmpty(item.Data, item.DataFormat, item.Type, item.Payload.Format, item.Payload.Type, item.MessageType, item.MsgType, item.ROSMessageType, item.Middleware) != "" &&
		item.Transport == "" &&
		len(item.Bindings) == 0 &&
		len(item.Routes) == 0
}

func isHighLevelServiceRoute(item ServiceRouteConfig) bool {
	return firstNonEmpty(item.Data, item.DataFormat, item.Type, item.Contract.Format, item.Contract.Type, item.ServiceType, item.MessageType, item.ROSServiceType, item.Middleware) != "" &&
		item.Transport == "" &&
		len(item.Bindings) == 0 &&
		len(item.Routes) == 0
}

func normalizeTopicRoute(item TopicRouteConfig) (TopicRouteConfig, error) {
	if !isHighLevelTopicRoute(item) {
		return item, nil
	}
	data := firstNonEmpty(item.Data, item.DataFormat, item.Payload.Format)
	routeType := firstNonEmpty(item.Payload.Type, item.Type, item.MessageType, item.MsgType, item.ROSMessageType)
	format := topicPayloadFormatFor(data, routeType)
	plan, err := topicExecutionPlan(item.Middleware, format)
	if err != nil {
		return item, err
	}
	item.Transport = plan.TransportName
	if plan.MiddlewareName != "" {
		item.Middleware = plan.MiddlewareName
	}
	if item.Payload.Format == "" {
		item.Payload.Format = format
	}
	if item.Payload.Type == "" {
		item.Payload.Type = routeType
	}
	if item.Payload.Format == "ros2_msg" && item.MessageType == "" {
		item.MessageType = item.Payload.Type
	}
	item.Metadata = putExecutionMetadata(item.Metadata, plan)
	if plan.TransportName == "ros2_topic" && item.Payload.Format == "protobuf" && routeAdapter(item.Adapter, item.Metadata) == "" {
		item.Adapter = "ros2_proto_envelope"
	}
	return item, nil
}

func normalizeServiceRoute(item ServiceRouteConfig) (ServiceRouteConfig, error) {
	if !isHighLevelServiceRoute(item) {
		return item, nil
	}
	data := firstNonEmpty(item.Data, item.DataFormat, item.Contract.Format)
	routeType := firstNonEmpty(item.Contract.Type, item.Type, item.ServiceType, item.MessageType, item.ROSServiceType)
	format := serviceContractFormatFor(data, routeType)
	plan, err := serviceExecutionPlan(item.Middleware, format)
	if err != nil {
		return item, err
	}
	item.Transport = plan.TransportName
	if plan.MiddlewareName != "" {
		item.Middleware = plan.MiddlewareName
	}
	if item.Contract.Format == "" {
		item.Contract.Format = format
	}
	if item.Contract.Type == "" {
		item.Contract.Type = routeType
	}
	if item.Contract.Format == "ros2_srv" && item.ServiceType == "" {
		item.ServiceType = item.Contract.Type
	}
	item.Metadata = putExecutionMetadata(item.Metadata, plan)
	if plan.TransportName == "ros2_service" && item.Contract.Format == "protobuf_rpc" && routeAdapter(item.Adapter, item.Metadata) == "" {
		item.Adapter = "ros2_proto_envelope"
	}
	return item, nil
}

func putExecutionMetadata(metadata map[string]string, plan routeExecutionPlan) map[string]string {
	out := mergeMetadata(metadata, nil)
	if plan.LogicalProtocol != "" {
		out["middleware.family"] = plan.LogicalProtocol
	}
	if plan.RuntimeMiddlewareName() != "" {
		out["middleware.runtime"] = plan.RuntimeMiddlewareName()
	}
	if plan.Implementation != "" {
		out["middleware.implementation"] = plan.Implementation
		out["implementation"] = plan.Implementation
	}
	if plan.Implementation == "rmw_cyclonedds" {
		out["rmw_implementation"] = "rmw_cyclonedds_cpp"
	} else if plan.Implementation == "rmw_fastrtps" {
		out["rmw_implementation"] = "rmw_fastrtps_cpp"
	}
	return out
}

func endpoint(transport communication.TransportKind, address string, metadata map[string]string, messageTypes ...string) communication.Endpoint {
	messageType := firstNonEmpty(messageTypes...)
	return communication.Endpoint{Transport: transport, Address: address, MessageType: messageType, Metadata: metadata}
}

func endpointType(transport communication.TransportKind, metadata map[string]string, fallbackTypes ...string) string {
	if transport == communication.TransportROS2 && normalizeAdapter(metadata["adapter"]) == "ros2_typed_mapper" {
		if rosType := firstNonEmpty(
			metadata["ros_message_type"],
			metadata["ros_service_type"],
			metadata["ros2.message_type"],
			metadata["ros2.service_type"],
		); rosType != "" {
			return rosType
		}
	}
	return firstNonEmpty(fallbackTypes...)
}

func payloadType(payload PayloadConfig) string {
	return strings.TrimSpace(payload.Type)
}

func contractType(contract PayloadConfig) string {
	return strings.TrimSpace(contract.Type)
}

func topicAddress(name string, item TopicRouteConfig, transport communication.TransportKind) string {
	if address := middlewareAddress(item.Addresses, item.Middleware, transport); address != "" {
		return address
	}
	if transport == communication.TransportNATS {
		return firstNonEmpty(item.Subject, item.NATSSubject, item.Address, "robot.topic."+name)
	}
	if transport == communication.TransportCycloneDDS || transport == communication.TransportFastDDS {
		return firstNonEmpty(item.Topic, item.DDSTopic, item.Address, strings.ReplaceAll(name, "/", "."))
	}
	if transport == communication.TransportROS2 {
		return firstNonEmpty(item.Address, item.Topic, item.Subject, "/"+strings.ReplaceAll(name, ".", "/"))
	}
	return firstNonEmpty(item.Address, item.Topic, item.Subject, name)
}

func serviceAddress(name string, item ServiceRouteConfig, transport communication.TransportKind) string {
	if address := middlewareAddress(item.Addresses, item.Middleware, transport); address != "" {
		return address
	}
	if transport == communication.TransportNATS {
		return firstNonEmpty(item.Subject, item.NATSSubject, item.Address, "robot.rpc."+name)
	}
	if transport == communication.TransportCycloneDDS || transport == communication.TransportFastDDS {
		return firstNonEmpty(item.Address, item.Service, item.Request, item.RequestChannel, strings.ReplaceAll(name, "/", ".")+".request")
	}
	if transport == communication.TransportROS2 {
		return firstNonEmpty(item.Address, item.Service, "/"+strings.ReplaceAll(name, ".", "/"))
	}
	return firstNonEmpty(item.Address, item.Service, name)
}

func middlewareAddress(addresses map[string]string, middleware string, transport communication.TransportKind) string {
	if len(addresses) == 0 {
		return ""
	}
	for _, key := range []string{middleware, string(transport), normalizeToken(middleware), normalizeToken(string(transport))} {
		if value := strings.TrimSpace(addresses[key]); value != "" {
			return value
		}
	}
	if transport == communication.TransportROS2 {
		if value := strings.TrimSpace(addresses["ros2"]); value != "" {
			return value
		}
	}
	if transport == communication.TransportNATS {
		if value := strings.TrimSpace(addresses["nats"]); value != "" {
			return value
		}
	}
	if transport == communication.TransportCycloneDDS {
		if value := strings.TrimSpace(firstNonEmpty(addresses["cyclonedds"], addresses["dds"])); value != "" {
			return value
		}
	}
	if transport == communication.TransportFastDDS {
		if value := strings.TrimSpace(addresses["fastdds"]); value != "" {
			return value
		}
	}
	return ""
}

func serviceRole(item ServiceRouteConfig) string {
	role := strings.ToLower(strings.TrimSpace(firstNonEmpty(item.Role, item.Direction)))
	switch role {
	case "client", "consumer", "request", "call", "out":
		return "client"
	default:
		return "server"
	}
}

func putServiceMetadata(metadata map[string]string, item ServiceRouteConfig, transport communication.TransportKind) {
	putAdapterMetadata(metadata, item.Adapter)
	putCodecMetadata(metadata, item.Contract.Format, contractType(item.Contract))
	putROS2TypeMetadata(metadata, "", item.ROSServiceType)
	if item.QueueGroup != "" {
		metadata["queue_group"] = item.QueueGroup
	}
	if item.Direction != "" {
		metadata["direction"] = item.Direction
	}
	if item.Role != "" {
		metadata["role"] = item.Role
	}
	if transport != communication.TransportCycloneDDS && transport != communication.TransportFastDDS {
		return
	}
	transportName := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(item.Transport)), "-", "_")
	if transportName == "cyclonedds_rpc" || transportName == "dds_rpc" || transportName == "fastdds_rpc" {
		if transport == communication.TransportFastDDS {
			metadata["rpc.transport"] = "fastdds_rpc"
		} else {
			metadata["rpc.transport"] = "cyclonedds_rpc"
		}
	}
	if transport == communication.TransportFastDDS {
		metadata["rpc.standard"] = "omg_dds_rpc"
	} else if standard := ddsRPCStandard(item.Standard); standard != "" {
		metadata["rpc.standard"] = standard
	}
	if request := strings.TrimSpace(firstNonEmpty(item.Request, item.RequestChannel)); request != "" {
		metadata["rpc.request_channel"] = request
	}
	if response := strings.TrimSpace(firstNonEmpty(item.Response, item.ResponseChannel)); response != "" {
		metadata["rpc.response_channel"] = response
	}
}

func putTopicMetadata(metadata map[string]string, item TopicRouteConfig) {
	putAdapterMetadata(metadata, item.Adapter)
	putCodecMetadata(metadata, item.Payload.Format, payloadType(item.Payload))
	putROS2TypeMetadata(metadata, item.ROSMessageType, "")
}

func putROS2TypeMetadata(metadata map[string]string, messageType string, serviceType string) {
	if value := strings.TrimSpace(messageType); value != "" {
		metadata["ros_message_type"] = value
		metadata["ros2.message_type"] = value
	}
	if value := strings.TrimSpace(serviceType); value != "" {
		metadata["ros_service_type"] = value
		metadata["ros2.service_type"] = value
	}
}

func putAdapterMetadata(metadata map[string]string, adapter string) {
	adapter = routeAdapter(adapter, metadata)
	if adapter == "" {
		return
	}
	metadata["adapter"] = adapter
	metadata["ros2.adapter"] = adapter
}

func putCodecMetadata(metadata map[string]string, format string, schemaType string) {
	normalized := codecMetadataFormat(format)
	switch normalized {
	case "protobuf", "protobuf_rpc":
		metadata["codec"] = "protobuf"
		metadata["schema.format"] = normalized
		if strings.TrimSpace(schemaType) != "" {
			metadata["schema.type"] = strings.TrimSpace(schemaType)
		}
	case "dds_idl", "dds_idl_rpc":
		metadata["codec"] = "cdr"
		metadata["schema.format"] = normalized
		metadata["schema.language"] = "omg_idl"
		metadata["dds.mode"] = "typed_preferred"
		metadata["dds.fallback"] = "byte_envelope"
		metadata["dds.runtime"] = "typed_native"
		metadata["dds.codegen"] = "required_for_typed"
		metadata["dds.envelope.type"] = "PacificRimMessageEnvelope"
		if strings.TrimSpace(schemaType) != "" {
			metadata["schema.type"] = strings.TrimSpace(schemaType)
			metadata["dds.type"] = strings.TrimSpace(schemaType)
		}
	}
}

func codecMetadataFormat(format string) string {
	normalized := normalizeDataFormat(format)
	switch normalized {
	case "protobuf_rpc", "request_reply", "request_response":
		return "protobuf_rpc"
	case "protobuf", "proto", "protobuf_message":
		return "protobuf"
	case "dds_idl_rpc", "omg_idl_rpc", "omg_dds_rpc_idl":
		return "dds_idl_rpc"
	case "dds_idl", "omg_idl", "omg_dds_idl", "ddsidl", "omgidl":
		return "dds_idl"
	default:
		return normalized
	}
}

func ddsRPCStandard(value string) string {
	normalized := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(value)), "-", "_")
	switch normalized {
	case "", "omg", "omg_dds_rpc", "dds_rpc":
		return "omg_dds_rpc"
	case "rmw", "rmw_cyclonedds", "rmw_cyclonedds_cpp", "ros2_rmw":
		return "rmw_cyclonedds"
	default:
		return normalized
	}
}

func validateTopicCompatibility(name string, item TopicRouteConfig, transport communication.TransportKind) error {
	format := strings.ToLower(strings.TrimSpace(item.Payload.Format))
	if format == "" && firstNonEmpty(item.MessageType, item.MsgType) != "" {
		format = "ros2_msg"
	}
	binding := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(defaultString(item.Transport, "nats_topic"))), "-", "_")
	if transport == communication.TransportROS2 && binding == "ros2_topic" && format != "" && format != "ros2_msg" && format != "rosidl_msg" {
		if format == "protobuf" && isROS2ProtoAdapter(routeAdapter(item.Adapter, item.Metadata)) {
			return nil
		}
		return fmt.Errorf("topic %s: ros2_topic is native for rosidl message; %s requires an adapter", name, format)
	}
	if transport == communication.TransportFastDDS && format != "" && !isNativeDDSTopicFormat(format) {
		return fmt.Errorf("topic %s: fastdds_topic is native for protobuf or OMG IDL CDR data; use middleware fastdds with data msg for ROS IDL data", name)
	}
	if binding == "cyclonedds_rpc" || binding == "dds_rpc" || binding == "fastdds_rpc" {
		return fmt.Errorf("topic %s: %s is request/reply; use communication.services", name, binding)
	}
	return nil
}

func validateServiceCompatibility(name string, item ServiceRouteConfig, transport communication.TransportKind) error {
	format := strings.ToLower(strings.TrimSpace(item.Contract.Format))
	if format == "" && firstNonEmpty(item.ServiceType, item.MessageType) != "" {
		format = "ros2_srv"
	}
	binding := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(defaultString(item.Transport, "nats_rpc"))), "-", "_")
	if transport == communication.TransportROS2 && binding == "ros2_service" && format != "" && format != "ros2_srv" && format != "rosidl_srv" {
		if format == "protobuf_rpc" && isROS2ProtoAdapter(routeAdapter(item.Adapter, item.Metadata)) {
			return nil
		}
		return fmt.Errorf("service %s: ros2_service is native for rosidl service; %s requires an adapter", name, format)
	}
	if binding == "grpc" && format != "" && format != "protobuf_rpc" {
		return fmt.Errorf("service %s: grpc is native for protobuf service; %s requires an adapter", name, format)
	}
	if transport == communication.TransportFastDDS && format != "" && !isNativeDDSServiceFormat(format) {
		return fmt.Errorf("service %s: fastdds_rpc is native for protobuf RPC or OMG DDS-RPC CDR data; use middleware fastdds with data srv for ROS IDL data", name)
	}
	if binding == "cyclonedds_topic" || binding == "dds_topic" || binding == "fastdds_topic" {
		return fmt.Errorf("service %s: %s is pub/sub; use cyclonedds_rpc or fastdds_rpc for request/reply", name, binding)
	}
	if binding == "cyclonedds_rpc" || binding == "dds_rpc" {
		standard := ddsRPCStandard(item.Standard)
		if standard != "omg_dds_rpc" && standard != "rmw_cyclonedds" {
			return fmt.Errorf("service %s: cyclonedds_rpc standard must be omg_dds_rpc or rmw_cyclonedds", name)
		}
	}
	if binding == "fastdds_rpc" && ddsRPCStandard(item.Standard) != "omg_dds_rpc" {
		return fmt.Errorf("service %s: fastdds_rpc standard must be omg_dds_rpc", name)
	}
	return nil
}

func routeAdapter(adapter string, metadata map[string]string) string {
	return normalizeAdapter(firstNonEmpty(adapter, metadata["adapter"], metadata["ros2.adapter"]))
}

func normalizeAdapter(value string) string {
	return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(value)), "-", "_")
}

func isROS2ProtoAdapter(adapter string) bool {
	switch normalizeAdapter(adapter) {
	case "ros2_proto_envelope", "ros2_typed_mapper":
		return true
	default:
		return false
	}
}

func timeoutMS(item ServiceRouteConfig) int {
	if item.TimeoutMS > 0 {
		return item.TimeoutMS
	}
	if item.Timeout > 0 {
		return int(item.Timeout / time.Millisecond)
	}
	return 2000
}

func routeName(value string) string {
	return strings.Trim(strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			return r
		}
		return '_'
	}, value), "_")
}

func mergeTopicRoutes(a map[string]TopicRouteConfig, b map[string]TopicRouteConfig) map[string]TopicRouteConfig {
	out := make(map[string]TopicRouteConfig, len(a)+len(b))
	for key, value := range a {
		out[key] = value
	}
	for key, value := range b {
		out[key] = value
	}
	return out
}

func mergeServiceRoutes(a map[string]ServiceRouteConfig, b map[string]ServiceRouteConfig) map[string]ServiceRouteConfig {
	out := make(map[string]ServiceRouteConfig, len(a)+len(b))
	for key, value := range a {
		out[key] = value
	}
	for key, value := range b {
		out[key] = value
	}
	return out
}

func expandTopicRoutes(routes map[string]TopicRouteConfig) (map[string]TopicRouteConfig, error) {
	out := map[string]TopicRouteConfig{}
	for name, route := range routes {
		bindings := topicBindings(route)
		if len(bindings) == 0 {
			var err error
			route, err = normalizeTopicRoute(route)
			if err != nil {
				return nil, fmt.Errorf("topic %s: %w", name, err)
			}
			route.Metadata = routeMetadata(route.Metadata, route.Middleware, name)
			putSecurityMetadata(route.Metadata, route.SecurityProfile)
			out[name] = route
			continue
		}
		base := route
		base.Bindings = nil
		base.Routes = nil
		for index, binding := range bindings {
			merged := mergeTopicRoute(base, binding)
			var err error
			merged, err = normalizeTopicRoute(merged)
			if err != nil {
				return nil, fmt.Errorf("topic %s binding %d: %w", name, index, err)
			}
			bindingName := topicBindingName(merged, index)
			merged.Metadata = routeMetadata(merged.Metadata, merged.Middleware, name)
			putSecurityMetadata(merged.Metadata, merged.SecurityProfile)
			merged.Metadata["logical_route"] = name
			merged.Metadata["binding_name"] = bindingName
			out[name+"_"+routeName(bindingName)] = merged
		}
	}
	return out, nil
}

func expandServiceRoutes(routes map[string]ServiceRouteConfig) (map[string]ServiceRouteConfig, error) {
	out := map[string]ServiceRouteConfig{}
	for name, route := range routes {
		bindings := serviceBindings(route)
		if len(bindings) == 0 {
			var err error
			route, err = normalizeServiceRoute(route)
			if err != nil {
				return nil, fmt.Errorf("service %s: %w", name, err)
			}
			route.Metadata = routeMetadata(route.Metadata, route.Middleware, name)
			putSecurityMetadata(route.Metadata, route.SecurityProfile)
			out[name] = route
			continue
		}
		base := route
		base.Bindings = nil
		base.Routes = nil
		for index, binding := range bindings {
			merged := mergeServiceRoute(base, binding)
			var err error
			merged, err = normalizeServiceRoute(merged)
			if err != nil {
				return nil, fmt.Errorf("service %s binding %d: %w", name, index, err)
			}
			bindingName := serviceBindingName(merged, index)
			merged.Metadata = routeMetadata(merged.Metadata, merged.Middleware, name)
			putSecurityMetadata(merged.Metadata, merged.SecurityProfile)
			merged.Metadata["logical_route"] = name
			merged.Metadata["binding_name"] = bindingName
			out[name+"_"+routeName(bindingName)] = merged
		}
	}
	return out, nil
}

func topicBindings(route TopicRouteConfig) []TopicRouteConfig {
	if len(route.Bindings) > 0 {
		return route.Bindings
	}
	return route.Routes
}

func serviceBindings(route ServiceRouteConfig) []ServiceRouteConfig {
	if len(route.Bindings) > 0 {
		return route.Bindings
	}
	return route.Routes
}

func mergeTopicRoute(base TopicRouteConfig, binding TopicRouteConfig) TopicRouteConfig {
	merged := base
	if binding.Enabled != nil {
		merged.Enabled = binding.Enabled
	}
	merged.Name = defaultString(binding.Name, merged.Name)
	merged.Data = defaultString(binding.Data, merged.Data)
	merged.DataFormat = defaultString(binding.DataFormat, merged.DataFormat)
	merged.Type = defaultString(binding.Type, merged.Type)
	merged.Transport = defaultString(binding.Transport, merged.Transport)
	merged.Middleware = defaultString(binding.Middleware, merged.Middleware)
	merged.Adapter = defaultString(binding.Adapter, merged.Adapter)
	merged.Direction = defaultString(binding.Direction, merged.Direction)
	merged.Subject = defaultString(binding.Subject, merged.Subject)
	merged.NATSSubject = defaultString(binding.NATSSubject, merged.NATSSubject)
	merged.Topic = defaultString(binding.Topic, merged.Topic)
	merged.DDSTopic = defaultString(binding.DDSTopic, merged.DDSTopic)
	merged.Address = defaultString(binding.Address, merged.Address)
	merged.Addresses = mergeStringMap(merged.Addresses, binding.Addresses)
	merged.MessageType = defaultString(binding.MessageType, merged.MessageType)
	merged.MsgType = defaultString(binding.MsgType, merged.MsgType)
	merged.ROSMessageType = defaultString(binding.ROSMessageType, merged.ROSMessageType)
	if binding.Payload.Type != "" || binding.Payload.Format != "" {
		merged.Payload = binding.Payload
	}
	if binding.QueueSize > 0 {
		merged.QueueSize = binding.QueueSize
	}
	merged.QueueGroup = defaultString(binding.QueueGroup, merged.QueueGroup)
	merged.SecurityProfile = defaultString(binding.SecurityProfile, merged.SecurityProfile)
	merged.Metadata = mergeMetadata(merged.Metadata, binding.Metadata)
	merged.QoS = mergeOptionsMap(merged.QoS, binding.QoS)
	return merged
}

func mergeServiceRoute(base ServiceRouteConfig, binding ServiceRouteConfig) ServiceRouteConfig {
	merged := base
	if binding.Enabled != nil {
		merged.Enabled = binding.Enabled
	}
	merged.Name = defaultString(binding.Name, merged.Name)
	merged.Data = defaultString(binding.Data, merged.Data)
	merged.DataFormat = defaultString(binding.DataFormat, merged.DataFormat)
	merged.Type = defaultString(binding.Type, merged.Type)
	merged.Transport = defaultString(binding.Transport, merged.Transport)
	merged.Middleware = defaultString(binding.Middleware, merged.Middleware)
	merged.Adapter = defaultString(binding.Adapter, merged.Adapter)
	merged.Subject = defaultString(binding.Subject, merged.Subject)
	merged.NATSSubject = defaultString(binding.NATSSubject, merged.NATSSubject)
	merged.Service = defaultString(binding.Service, merged.Service)
	merged.Request = defaultString(binding.Request, merged.Request)
	merged.Response = defaultString(binding.Response, merged.Response)
	merged.RequestChannel = defaultString(binding.RequestChannel, merged.RequestChannel)
	merged.ResponseChannel = defaultString(binding.ResponseChannel, merged.ResponseChannel)
	merged.Standard = defaultString(binding.Standard, merged.Standard)
	merged.Direction = defaultString(binding.Direction, merged.Direction)
	merged.Role = defaultString(binding.Role, merged.Role)
	merged.Address = defaultString(binding.Address, merged.Address)
	merged.Addresses = mergeStringMap(merged.Addresses, binding.Addresses)
	merged.MessageType = defaultString(binding.MessageType, merged.MessageType)
	merged.ServiceType = defaultString(binding.ServiceType, merged.ServiceType)
	merged.ROSServiceType = defaultString(binding.ROSServiceType, merged.ROSServiceType)
	if binding.Contract.Type != "" || binding.Contract.Format != "" {
		merged.Contract = binding.Contract
	}
	if binding.Timeout > 0 {
		merged.Timeout = binding.Timeout
	}
	if binding.TimeoutMS > 0 {
		merged.TimeoutMS = binding.TimeoutMS
	}
	merged.QueueGroup = defaultString(binding.QueueGroup, merged.QueueGroup)
	merged.SecurityProfile = defaultString(binding.SecurityProfile, merged.SecurityProfile)
	merged.Metadata = mergeMetadata(merged.Metadata, binding.Metadata)
	merged.QoS = mergeOptionsMap(merged.QoS, binding.QoS)
	return merged
}

func routeMetadata(metadata map[string]string, middleware string, sourceName string) map[string]string {
	out := mergeMetadata(metadata, nil)
	if strings.TrimSpace(middleware) != "" {
		out["middleware"] = strings.TrimSpace(middleware)
	}
	if strings.TrimSpace(sourceName) != "" {
		out["source_name"] = strings.TrimSpace(sourceName)
		if strings.TrimSpace(out["logical_route"]) == "" {
			out["logical_route"] = strings.TrimSpace(sourceName)
		}
	}
	return out
}

func putSecurityMetadata(metadata map[string]string, profile string) {
	if strings.TrimSpace(profile) == "" {
		return
	}
	metadata[SecurityMetadataProfile] = strings.TrimSpace(profile)
}

func mergeMetadata(a map[string]string, b map[string]string) map[string]string {
	out := map[string]string{}
	for key, value := range a {
		out[key] = value
	}
	for key, value := range b {
		out[key] = value
	}
	return out
}

func mergeStringMap(a map[string]string, b map[string]string) map[string]string {
	out := map[string]string{}
	for key, value := range a {
		out[key] = value
	}
	for key, value := range b {
		out[key] = value
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func topicBindingName(item TopicRouteConfig, index int) string {
	return bindingName(index, item.Name, item.Middleware, item.Transport, item.Topic, item.DDSTopic, item.Subject, item.NATSSubject, item.Address)
}

func serviceBindingName(item ServiceRouteConfig, index int) string {
	return bindingName(
		index,
		item.Name,
		item.Middleware,
		item.Transport,
		item.Standard,
		item.Service,
		item.Request,
		item.RequestChannel,
		item.Response,
		item.ResponseChannel,
		item.Subject,
		item.NATSSubject,
		item.Address,
	)
}

func bindingName(index int, values ...string) string {
	parts := make([]string, 0, len(values))
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			parts = append(parts, trimmed)
		}
	}
	if len(parts) > 0 {
		return strings.Join(parts, "_")
	}
	return fmt.Sprintf("binding_%d", index)
}

func copyOptions(options map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range options {
		out[key] = value
	}
	return out
}

func middlewareOptions(item MiddlewareConfig) map[string]any {
	options := copyOptions(item.Options)
	putIfNonEmpty(options, "server_url", item.ServerURL)
	putIfNonZero(options, "domain_id", item.DomainID)
	putIfNonZero(options, "ros_domain_id", item.ROSDomainID)
	putIfNonEmpty(options, "participant_name", item.ParticipantName)
	putIfNonEmpty(options, "config_uri", item.ConfigURI)
	putIfNonEmpty(options, "type_name", item.TypeName)
	putIfNonEmpty(options, "mode", item.Mode)
	putIfNonEmpty(options, "implementation", item.Implementation)
	putIfNonEmpty(options, "rmw_implementation", item.RMWImplementation)
	putBridgeOptions(options, item.Bridge)
	putIfNonZero(options, "connect_timeout_ms", item.ConnectTimeoutMS)
	putIfNonZero(options, "reconnect_wait_ms", item.ReconnectWaitMS)
	putIfNonZero(options, "max_reconnect_attempts", item.MaxReconnectAttempts)
	putQoSOptions(options, item.QoS)
	putIfNonEmpty(options, SecurityOptionProfile, item.SecurityProfile)
	return options
}

func applyMiddlewareTransportDefaults(options map[string]any, transportName string) {
	switch normalizeToken(transportName) {
	case "fastdds", "fast_dds", "fastrtps", "fast_rtps", "fastdds_topic", "fastdds_rpc":
		putIfAbsent(options, "middleware.family", "fastdds")
		putIfAbsent(options, "implementation", "native_fastdds")
	}
}

func putIfAbsent(options map[string]any, key string, value any) {
	if _, ok := options[key]; !ok {
		options[key] = value
	}
}

func mergeOptionsMap(a map[string]any, b map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range a {
		out[key] = value
	}
	for key, value := range b {
		out[key] = value
	}
	return out
}

func putQoSOptions(options map[string]any, qos map[string]any) {
	for key, value := range qos {
		options["qos."+key] = value
	}
}

func putBridgeOptions(options map[string]any, bridge map[string]any) {
	for key, value := range bridge {
		options["bridge."+key] = value
	}
}

func putQoSMetadata(metadata map[string]string, qos map[string]any) {
	for key, value := range qos {
		metadata["qos."+key] = fmt.Sprint(value)
	}
}

func putIfNonEmpty(options map[string]any, key string, value string) {
	if strings.TrimSpace(value) != "" {
		options[key] = value
	}
}

func putIfNonZero(options map[string]any, key string, value int) {
	if value != 0 {
		options[key] = value
	}
}

func enabled(value *bool) bool {
	return value == nil || *value
}

func queueSize(value int) int {
	if value > 0 {
		return value
	}
	return 10
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func defaultString(value string, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func parseInt(value any) (int, error) {
	switch typed := value.(type) {
	case int:
		return typed, nil
	case string:
		return strconv.Atoi(typed)
	default:
		return 0, fmt.Errorf("unsupported integer value %v", value)
	}
}
