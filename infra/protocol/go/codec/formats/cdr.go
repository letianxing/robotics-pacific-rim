package formats

import protocolencodings "github.com/pacific-rim/pacific-rim/infra/protocol/go/codec/encodings"

// CDRFormat is a compatibility wrapper for older callers.
//
// Deprecated: CDR is a wire encoding, not an IDL/data-format contract. Prefer
// encodings.CDR and describe the source schema with ROS2MsgFormat,
// ROS2SrvFormat, ROS2IDLFormat, or ROS2TypeSupportFormat.
func CDRFormat(typeName string) DataFormat {
	return DataFormat{
		Kind:        DataFormatRawBytes,
		TypeName:    typeName,
		ContentType: protocolencodings.CDR(typeName).ResolvedContentType(),
		Metadata: map[string]string{
			"encoding": string(protocolencodings.WireEncodingCDR),
		},
	}
}
