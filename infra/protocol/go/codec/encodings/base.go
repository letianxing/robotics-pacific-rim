package encodings

type WireEncodingKind string

const (
	WireEncodingCDR WireEncodingKind = "cdr"
)

type WireEncoding struct {
	Kind        WireEncodingKind  `json:"kind" yaml:"kind"`
	TypeName    string            `json:"type_name,omitempty" yaml:"type_name,omitempty"`
	Package     string            `json:"package,omitempty" yaml:"package,omitempty"`
	SchemaPath  string            `json:"schema_path,omitempty" yaml:"schema_path,omitempty"`
	ContentType string            `json:"content_type,omitempty" yaml:"content_type,omitempty"`
	Metadata    map[string]string `json:"metadata,omitempty" yaml:"metadata,omitempty"`
}

func (encoding WireEncoding) ResolvedContentType() string {
	if encoding.ContentType != "" {
		return encoding.ContentType
	}
	return ContentTypeForEncoding(encoding.Kind)
}

func ContentTypeForEncoding(kind WireEncodingKind) string {
	switch kind {
	case WireEncodingCDR:
		return "application/vnd.omg.cdr"
	default:
		return "application/octet-stream"
	}
}
