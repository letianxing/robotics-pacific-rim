package formats

func ROS2MsgFormat(typeName string) DataFormat {
	return DataFormat{
		Kind:     DataFormatROS2Msg,
		TypeName: typeName,
	}
}

func ROS2SrvFormat(typeName string) DataFormat {
	return DataFormat{
		Kind:     DataFormatROS2Srv,
		TypeName: typeName,
	}
}

func ROS2IDLFormat(typeName string) DataFormat {
	return DataFormat{
		Kind:     DataFormatROS2IDL,
		TypeName: typeName,
	}
}

func ROS2TypeSupportFormat(typeName string) DataFormat {
	return DataFormat{
		Kind:     DataFormatROS2TypeSupport,
		TypeName: typeName,
	}
}
