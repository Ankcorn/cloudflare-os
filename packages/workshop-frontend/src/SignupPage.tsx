import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { RpcStub } from 'capnweb'
import { PublicApi } from '@gadgets/workshop-shared/api'
import { Card, Form, Input, Button, Typography, Alert } from 'antd'
import { hashPassword } from './passwordHash'

const { Title, Text } = Typography

interface SignupPageProps {
  rpcStub: RpcStub<PublicApi>
}

export default function SignupPage({ rpcStub }: SignupPageProps) {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (values: {
    username: string
    displayName: string
    password: string
  }) => {
    setLoading(true)
    setError(null)

    try {
      const passwordHash = await hashPassword(values.username, values.password)
      const token = await rpcStub.createAccount(
        values.username,
        values.displayName,
        passwordHash
      )
      if (token) {
        localStorage.setItem('authToken', token)
        navigate('/')
        window.location.reload()
      } else {
        setError('Username already exists')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Account creation failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#f5f5f5',
        padding: '0 16px',
      }}
    >
      <Card
        style={{
          maxWidth: 400,
          width: '100%',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <Title level={1} style={{ marginBottom: 8 }}>
            Gadgets Workshop
          </Title>
          <Text type="secondary">
            Create your account
          </Text>
        </div>

        <Form
          onFinish={handleSubmit}
          layout="vertical"
          size="large"
        >
          <Form.Item
            label="Username"
            name="username"
            rules={[
              { required: true, message: 'Please choose a username' },
              { pattern: /^[a-z0-9_-]+$/i, message: 'Username can only contain letters, numbers, underscores, and hyphens' },
            ]}
          >
            <Input
              disabled={loading}
              autoFocus
              autoComplete="username"
            />
          </Form.Item>

          <Form.Item
            label="Display Name"
            name="displayName"
            rules={[{ required: true, message: 'Please enter your display name' }]}
          >
            <Input
              disabled={loading}
              autoComplete="name"
            />
          </Form.Item>

          <Form.Item
            label="Password"
            name="password"
            rules={[
              { required: true, message: 'Please choose a password' },
              { min: 8, message: 'Password must be at least 8 characters' },
            ]}
          >
            <Input.Password
              disabled={loading}
              autoComplete="new-password"
            />
          </Form.Item>

          <Form.Item
            label="Confirm Password"
            name="confirmPassword"
            dependencies={['password']}
            rules={[
              { required: true, message: 'Please confirm your password' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('password') === value) {
                    return Promise.resolve()
                  }
                  return Promise.reject(new Error('Passwords do not match'))
                },
              }),
            ]}
          >
            <Input.Password
              disabled={loading}
              autoComplete="new-password"
            />
          </Form.Item>

          {error && (
            <Alert
              message={error}
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}

          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              loading={loading}
              size="large"
              block
            >
              Create Account
            </Button>
          </Form.Item>
        </Form>

        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <Text type="secondary">
            Already have an account?{' '}
            <Link to="/login">Sign in</Link>
          </Text>
        </div>
      </Card>
    </div>
  )
}
