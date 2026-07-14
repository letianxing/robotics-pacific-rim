package ros2

import (
	"errors"
	"fmt"
	"strings"
)

func splitROS2MessageType(value string) (string, string, error) {
	normalized := strings.Trim(strings.ReplaceAll(value, ".", "/"), "/")
	if normalized == "" {
		return "", "", errors.New("ROS2 native topic requires channel.message_type, for example std_msgs/msg/String")
	}
	parts := strings.Split(normalized, "/")
	if len(parts) == 2 {
		return parts[0], parts[1], nil
	}
	if len(parts) == 3 && parts[1] == "msg" {
		return parts[0], parts[2], nil
	}
	return "", "", fmt.Errorf("unsupported ROS2 message type %q; expected <package>/msg/<Type>", value)
}
