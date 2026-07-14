package ros2

import (
	"errors"
	"fmt"
	"strings"
)

func splitROS2ServiceType(value string) (string, string, error) {
	normalized := strings.Trim(strings.ReplaceAll(value, ".", "/"), "/")
	if normalized == "" {
		return "", "", errors.New("ROS2 native service requires channel.message_type, for example example_interfaces/srv/AddTwoInts")
	}
	parts := strings.Split(normalized, "/")
	if len(parts) == 2 {
		return parts[0], parts[1], nil
	}
	if len(parts) == 3 && parts[1] == "srv" {
		return parts[0], parts[2], nil
	}
	return "", "", fmt.Errorf("unsupported ROS2 service type %q; expected <package>/srv/<Type>", value)
}
