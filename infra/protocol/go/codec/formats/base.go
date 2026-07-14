package formats

type DataFormatKind string

const (
	DataFormatRawBytes        DataFormatKind = "raw_bytes"
	DataFormatJSON            DataFormatKind = "json"
	DataFormatProtobuf        DataFormatKind = "protobuf"
	DataFormatROS2Msg         DataFormatKind = "ros2_msg"
	DataFormatROS2Srv         DataFormatKind = "ros2_srv"
	DataFormatROS2IDL         DataFormatKind = "ros2_idl"
	DataFormatROS2TypeSupport DataFormatKind = "ros2_type_support"
)

type DataFormat struct {
	Kind        DataFormatKind    `json:"kind" yaml:"kind"`
	TypeName    string            `json:"type_name,omitempty" yaml:"type_name,omitempty"`
	Package     string            `json:"package,omitempty" yaml:"package,omitempty"`
	SchemaPath  string            `json:"schema_path,omitempty" yaml:"schema_path,omitempty"`
	ContentType string            `json:"content_type,omitempty" yaml:"content_type,omitempty"`
	Metadata    map[string]string `json:"metadata,omitempty" yaml:"metadata,omitempty"`
}

func (format DataFormat) ResolvedContentType() string {
	if format.ContentType != "" {
		return format.ContentType
	}
	return ContentTypeForFormat(format.Kind)
}

func ContentTypeForFormat(kind DataFormatKind) string {
	switch kind {
	case DataFormatRawBytes:
		return "application/octet-stream"
	case DataFormatJSON:
		return "application/json"
	case DataFormatProtobuf:
		return "application/protobuf"
	case DataFormatROS2Msg:
		return "application/vnd.ros2.msg"
	case DataFormatROS2Srv:
		return "application/vnd.ros2.srv"
	case DataFormatROS2IDL:
		return "application/vnd.ros2.idl"
	case DataFormatROS2TypeSupport:
		return "application/vnd.ros2.type-support"
	default:
		return "application/octet-stream"
	}
}
