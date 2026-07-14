package codec

import protocolformats "github.com/pacific-rim/pacific-rim/infra/protocol/go/codec/formats"
import protocolencodings "github.com/pacific-rim/pacific-rim/infra/protocol/go/codec/encodings"

type DataFormatKind = protocolformats.DataFormatKind
type DataFormat = protocolformats.DataFormat
type WireEncodingKind = protocolencodings.WireEncodingKind
type WireEncoding = protocolencodings.WireEncoding

const (
	DataFormatRawBytes        = protocolformats.DataFormatRawBytes
	DataFormatJSON            = protocolformats.DataFormatJSON
	DataFormatProtobuf        = protocolformats.DataFormatProtobuf
	DataFormatROS2Msg         = protocolformats.DataFormatROS2Msg
	DataFormatROS2Srv         = protocolformats.DataFormatROS2Srv
	DataFormatROS2IDL         = protocolformats.DataFormatROS2IDL
	DataFormatROS2TypeSupport = protocolformats.DataFormatROS2TypeSupport
	WireEncodingCDR           = protocolencodings.WireEncodingCDR
)

func ContentTypeForFormat(kind DataFormatKind) string {
	return protocolformats.ContentTypeForFormat(kind)
}

func ContentTypeForEncoding(kind WireEncodingKind) string {
	return protocolencodings.ContentTypeForEncoding(kind)
}
