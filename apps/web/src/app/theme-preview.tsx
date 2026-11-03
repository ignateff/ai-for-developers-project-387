import { useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Container,
  Divider,
  Group,
  Loader,
  Paper,
  Radio,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core";

export function ThemePreview() {
  const { setColorScheme } = useMantineColorScheme();
  const colorScheme = useComputedColorScheme("light");
  const [slot, setSlot] = useState("09:30");

  return (
    <div className="preview">
      <header className="preview-header">
        <Container size="lg" className="header-content">
          <Group gap="xs">
            <span className="brand-icon" aria-hidden="true">
              ▦
            </span>
            <Text fw={700}>Calendar</Text>
          </Group>
          <Group gap="sm">
            <Text size="sm" c="dimmed" visibleFrom="xs">
              Тема компонентов
            </Text>
            <Button
              variant="default"
              size="xs"
              onClick={() => setColorScheme(colorScheme === "dark" ? "light" : "dark")}
            >
              {colorScheme === "dark" ? "Светлая тема" : "Тёмная тема"}
            </Button>
          </Group>
        </Container>
      </header>
      <Container size="lg" py="xl">
        <Title order={1} className="page-title">
          Тема календаря
        </Title>
        <Text c="dimmed" mt="xs">
          Компоненты и состояния на основе макета записи на звонок
        </Text>
        <div className="preview-grid">
          <Paper withBorder radius="lg" p="lg" className="preview-panel">
            <Title order={2} size="h4">
              Кнопки и действия
            </Title>
            <Text size="sm" c="dimmed" mt={4}>
              Основные и вспомогательные действия
            </Text>
            <Stack mt="lg" gap="md">
              <Group>
                <Button>Продолжить</Button>
                <Button variant="outline">Выбрать время</Button>
                <Button variant="subtle">Отмена</Button>
              </Group>
              <Group>
                <Button disabled>Недоступно</Button>
                <Button loading>Загрузка</Button>
                <ActionIcon variant="default" size="lg" aria-label="Предыдущий месяц">
                  ‹
                </ActionIcon>
                <ActionIcon variant="default" size="lg" aria-label="Следующий месяц">
                  ›
                </ActionIcon>
              </Group>
              <Divider />
              <Text size="sm" fw={600}>
                Свободное время
              </Text>
              <Group gap="xs">
                {["09:30", "10:00", "10:30"].map((time) => (
                  <Button
                    key={time}
                    size="xs"
                    variant={slot === time ? "filled" : "outline"}
                    onClick={() => setSlot(time)}
                    aria-pressed={slot === time}
                  >
                    {time}
                  </Button>
                ))}
                <Button size="xs" disabled>
                  11:00
                </Button>
              </Group>
            </Stack>
          </Paper>
          <Paper withBorder radius="lg" p="lg" className="preview-panel">
            <Title order={2} size="h4">
              Поля формы
            </Title>
            <Text size="sm" c="dimmed" mt={4}>
              Введите данные для записи
            </Text>
            <Stack mt="lg" gap="md">
              <TextInput label="Имя" placeholder="Как к вам обращаться" />
              <TextInput
                label="Электронная почта"
                placeholder="name@example.com"
                error="Введите корректный адрес"
              />
              <Select
                label="Тип встречи"
                data={["Знакомство", "Консультация"]}
                defaultValue="Знакомство"
              />
              <TextInput label="Недоступное поле" placeholder="Недоступно" disabled />
            </Stack>
          </Paper>
          <Paper withBorder radius="lg" p="lg" className="preview-panel">
            <Title order={2} size="h4">
              Выбор и статусы
            </Title>
            <Text size="sm" c="dimmed" mt={4}>
              Интерактивные элементы и метки
            </Text>
            <Stack mt="lg" gap="md">
              <Group>
                <Checkbox label="Согласие" defaultChecked />
                <Checkbox label="Недоступно" disabled />
              </Group>
              <Radio.Group name="meeting" defaultValue="online" label="Формат встречи">
                <Group mt="xs">
                  <Radio value="online" label="Онлайн" />
                  <Radio value="phone" label="По телефону" />
                </Group>
              </Radio.Group>
              <Switch label="Уведомления" defaultChecked />
              <Divider />
              <Group>
                <Badge>Свободно</Badge>
                <Badge variant="light">Выбрано</Badge>
                <Badge color="gray" variant="light">
                  Недоступно
                </Badge>
                <Loader size="xs" />
              </Group>
            </Stack>
          </Paper>
          <Paper withBorder radius="lg" p="lg" className="preview-panel">
            <Title order={2} size="h4">
              Информация о записи
            </Title>
            <Text size="sm" c="dimmed" mt={4}>
              Пример поверхностей и сообщений
            </Text>
            <Stack mt="lg" gap="sm">
              <div className="selection">
                <Text size="sm" c="dimmed">
                  Выбранное время
                </Text>
                <Text fw={600} mt={4}>
                  {slot} · 30 минут
                </Text>
              </div>
              <Alert color="brand" title="Время доступно">
                Выберите слот и заполните данные для записи.
              </Alert>
              <Alert color="red" title="Не удалось сохранить">
                Проверьте данные и попробуйте ещё раз.
              </Alert>
            </Stack>
          </Paper>
        </div>
      </Container>
    </div>
  );
}
