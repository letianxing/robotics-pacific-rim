package formats

func ProtobufFormat(typeName string) DataFormat {
	return DataFormat{
		Kind:     DataFormatProtobuf,
		TypeName: typeName,
	}
}
