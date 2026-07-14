package encodings

func CDR(typeName string) WireEncoding {
	return WireEncoding{
		Kind:     WireEncodingCDR,
		TypeName: typeName,
	}
}
